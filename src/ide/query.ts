import * as vscode from 'vscode';
import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { redactText } from '../diagnostics/redaction';

export const IDE_REQUEST_TITLE = 'pi-vscode-ide-v1';
export interface IdeLocation {
  path: string;
  line: number;
  character: number;
  name?: string;
  message?: string;
  severity?: number;
}
export interface IdeResult {
  vscodeIde: 1;
  operation: string;
  status: 'ok' | 'empty' | 'error' | 'restricted' | 'cancelled' | 'timeout';
  message: string;
  locations: IdeLocation[];
  truncated?: boolean;
  omitted?: number;
}
let extensionPath: string | undefined;
export function setIdeExtensionPath(value: string): void {
  extensionPath = value;
}
export function getIdeExtensionPath(): string | undefined {
  return extensionPath;
}

const operations = ['diagnostics', 'document_symbols', 'definitions', 'references'];
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 1000000;
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function scopedFile(root: string, value: unknown): Promise<string> {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\u0000-\u001f]/.test(value) ||
    (/^[a-z][a-z0-9+.-]*:/i.test(value) && !path.isAbsolute(value))
  )
    throw new Error('Invalid path');
  const candidate = path.resolve(root, value);
  const canonical = await realpath(candidate);
  if (!inside(root, canonical) || !(await stat(canonical)).isFile())
    throw new Error('Outside chat folder or not a file');
  return canonical;
}

function documentPosition(
  document: vscode.TextDocument,
  line: unknown,
  character: unknown
): vscode.Position {
  if (!integer(line) || !integer(character)) throw new Error('Invalid location');
  if (line > document.lineCount || character > document.lineAt(line - 1).text.length + 1)
    throw new Error('Invalid location');
  return new vscode.Position(line - 1, character - 1);
}

async function readDocument(file: string): Promise<vscode.TextDocument> {
  for (const document of (vscode.workspace.textDocuments ?? []).slice(0, 1000)) {
    if (
      document.uri.scheme !== 'file' ||
      (document.uri.authority ?? '') !== (vscode.Uri.file(file).authority ?? '')
    )
      continue;
    try {
      if ((await realpath(document.uri.fsPath)) === file) return document;
    } catch {
      /* A deleted buffer cannot be queried as an existing file. */
    }
  }
  return vscode.workspace.openTextDocument(vscode.Uri.file(file));
}

/** A click is the only path from these read-only queries to an editor tab. */
export async function openIdeLocation(cwd: string, location: IdeLocation): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const root = await realpath(cwd);
  const file = await scopedFile(root, location.path);
  const document = await readDocument(file);
  const position = documentPosition(document, location.line, location.character);
  if (!vscode.workspace.isTrusted) return;
  await vscode.window.showTextDocument(document, {
    preview: true,
    selection: new vscode.Range(position, position),
  });
}

export async function runIdeQuery(
  cwd: string,
  input: unknown,
  signal: AbortSignal,
  current: () => boolean
): Promise<IdeResult> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const operation =
    typeof record?.operation === 'string' && operations.includes(record.operation)
      ? record.operation
      : '';
  const result = (
    status: IdeResult['status'],
    message: string,
    locations: IdeLocation[] = []
  ): IdeResult => ({ vscodeIde: 1, operation, status, message, locations });
  const valid = (): boolean => !signal.aborted && current();
  if (!valid()) return result('cancelled', 'Editor query cancelled because the chat changed.');
  if (!vscode.workspace.isTrusted)
    return result(
      'restricted',
      'Editor queries require a trusted workspace. Native permitted tools remain available.'
    );
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return result('error', 'Invalid editor query.');
  const request = input as Record<string, unknown>;
  if (
    !operations.includes(operation) ||
    Object.keys(request).some((key) => !['operation', 'path', 'line', 'character'].includes(key))
  )
    return result('error', 'Invalid editor query.');
  if (
    !['definitions', 'references'].includes(operation) &&
    (request.line !== undefined || request.character !== undefined)
  )
    return result('error', 'Unexpected location.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let expired = false;
  const active = (): boolean => valid() && !expired && vscode.workspace.isTrusted;
  const work = async (): Promise<IdeResult> => {
    try {
      const root = await realpath(cwd);
      const file =
        request.path === undefined && operation === 'diagnostics'
          ? undefined
          : await scopedFile(root, request.path);
      if (!active()) return result('cancelled', 'Editor query cancelled.');
      const locations: IdeLocation[] = [];
      let truncated = false;
      let bytes = 0;
      let visited = 0;
      let omitted = 0;
      const authority = vscode.Uri.file(root).authority ?? '';
      const add = async (
        uri: vscode.Uri | undefined,
        start: vscode.Position | undefined,
        extra: Pick<IdeLocation, 'name' | 'message' | 'severity'> = {}
      ): Promise<void> => {
        if (!active()) return;
        if (locations.length >= 100 || bytes >= 24000) {
          truncated = true;
          return;
        }
        if (
          uri?.scheme !== 'file' ||
          (uri.authority ?? '') !== authority ||
          !start ||
          !Number.isSafeInteger(start.line) ||
          !Number.isSafeInteger(start.character) ||
          start.line < 0 ||
          start.character < 0 ||
          start.line >= 1000000 ||
          start.character >= 1000000
        ) {
          omitted++;
          return;
        }
        try {
          const target = await scopedFile(root, uri.fsPath);
          if (!active()) return;
          const entry: IdeLocation = {
            path: path.relative(root, target),
            line: start.line + 1,
            character: start.character + 1,
            ...extra,
          };
          const size = JSON.stringify(entry).length;
          if (bytes + size > 24000) {
            truncated = true;
            return;
          }
          bytes += size;
          locations.push(entry);
        } catch {
          omitted++; /* Language services can return external library locations; omit them. */
        }
      };
      if (operation === 'diagnostics') {
        const document = file ? await readDocument(file) : undefined;
        const entries: readonly [vscode.Uri, readonly vscode.Diagnostic[]][] = document
          ? [[document.uri, vscode.languages.getDiagnostics(document.uri)]]
          : vscode.languages.getDiagnostics();
        for (const [uri, diagnostics] of entries) {
          if (++visited > 2000 || locations.length >= 100 || !active()) {
            truncated = true;
            break;
          }
          for (const diagnostic of diagnostics) {
            if (++visited > 2000 || locations.length >= 100 || !active()) {
              truncated = true;
              break;
            }
            await add(uri, diagnostic.range?.start, {
              message: redactText(String(diagnostic.message).slice(0, 1000)),
              severity: diagnostic.severity,
            });
          }
        }
      } else {
        const document = await readDocument(file!);
        const uri = document.uri;
        if (operation === 'document_symbols') {
          if (!active()) return result('cancelled', 'Editor query cancelled.');
          const symbols = await vscode.commands.executeCommand<
            Array<vscode.DocumentSymbol | vscode.SymbolInformation>
          >('vscode.executeDocumentSymbolProvider', uri);
          const pending = Array.isArray(symbols) ? symbols.slice(0, 1000).reverse() : [];
          if ((symbols?.length ?? 0) > 1000) truncated = true;
          while (pending.length && active()) {
            if (++visited > 1000 || locations.length >= 100) {
              truncated = true;
              break;
            }
            const symbol = pending.pop()!;
            const named = { name: redactText(String(symbol.name).slice(0, 200)) };
            if ('location' in symbol)
              await add(symbol.location.uri, symbol.location.range?.start, named);
            else {
              await add(uri, symbol.selectionRange?.start ?? symbol.range?.start, named);
              if (Array.isArray(symbol.children)) {
                const room = Math.max(0, 1000 - pending.length);
                pending.push(...symbol.children.slice(0, room).reverse());
                if (symbol.children.length > room) truncated = true;
              }
            }
          }
        } else {
          const position = documentPosition(document, request.line, request.character);
          if (!active()) return result('cancelled', 'Editor query cancelled.');
          const command =
            operation === 'definitions'
              ? 'vscode.executeDefinitionProvider'
              : 'vscode.executeReferenceProvider';
          const matches = await vscode.commands.executeCommand<
            Array<vscode.Location | vscode.LocationLink>
          >(command, uri, position);
          for (const match of Array.isArray(matches) ? matches.slice(0, 1000) : []) {
            if (!active()) break;
            if ('targetUri' in match)
              await add(
                match.targetUri,
                match.targetSelectionRange?.start ?? match.targetRange?.start
              );
            else await add(match.uri, match.range?.start);
          }
          if ((matches?.length ?? 0) > 1000) truncated = true;
        }
      }
      if (!active()) return result('cancelled', 'Editor query cancelled because the chat changed.');
      return {
        ...result(
          locations.length ? 'ok' : 'empty',
          locations.length
            ? `${locations.length} editor location(s).`
            : 'No matching editor results. Provider availability is unknown; use native project tools if needed.',
          locations
        ),
        ...(truncated ? { truncated: true } : {}),
        ...(omitted ? { omitted } : {}),
      };
    } catch {
      return result(
        'error',
        'Editor query failed: check the file, location and installed language service. No files were changed.'
      );
    }
  };
  const interrupted = new Promise<IdeResult>((resolve) => {
    onAbort = () => resolve(result('cancelled', 'Editor query cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      expired = true;
      resolve(result('timeout', 'Editor query timed out. Continue with native project tools.'));
    }, 8000);
  });
  try {
    return await Promise.race([work(), interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
