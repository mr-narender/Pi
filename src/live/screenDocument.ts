// π Screen: ONE virtual document (`pi-screen://live/π Screen`) that mirrors
// whatever file the agent is touching. VS Code de-duplicates tabs by resource
// identity, so this is mathematically a single tab — content swaps IN PLACE
// as π moves file-to-file (the Chrome-split-view container, done natively).
// Real editor surface: genuine syntax highlighting, decorations, reveal.
// Read-only by design — the header path is a link to the real file.
import { extname } from 'node:path';
import * as vscode from 'vscode';

const SCHEME = 'pi-screen';
const SCREEN_URI = vscode.Uri.from({ scheme: SCHEME, authority: 'live', path: '/π Screen' });
/** Mirror window for huge files: keep the editor snappy. */
const MAX_MIRROR_CHARS = 200_000;

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.lua': 'lua',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.md': 'markdown',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.vue': 'vue',
  '.sql': 'sql',
  '.xml': 'xml',
};

const HASH_COMMENT_LANGS = new Set(['python', 'ruby', 'shellscript', 'yaml', 'toml']);
const DASH_COMMENT_LANGS = new Set(['lua', 'sql']);
const PLAIN_COMMENT_LANGS = new Set(['markdown', 'html', 'xml', 'plaintext']);

export function languageForPath(filePath: string): string {
  return LANG_BY_EXT[extname(filePath).toLowerCase()] ?? 'plaintext';
}

export function headerPrefix(languageId: string): string {
  if (HASH_COMMENT_LANGS.has(languageId)) {
    return '# ';
  }
  if (DASH_COMMENT_LANGS.has(languageId)) {
    return '-- ';
  }
  if (PLAIN_COMMENT_LANGS.has(languageId)) {
    return '';
  }
  return '// ';
}

export interface ScreenActivity {
  kind: 'editing' | 'reading';
  absolute: string;
  chatTitle: string;
  /** 1-based line to reveal (reads), or undefined. */
  revealLine?: number;
  /** Text to locate and glow (edits), or undefined. */
  needle?: string;
  column: vscode.ViewColumn;
  /** The chat's own column — used to detect same-group placement. */
  chatColumn?: number;
}

export class PiScreen implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private content = 'π Screen — waiting for agent activity. Files π reads or edits appear here.';
  private warnedPlacement = false;
  private currentLanguage = 'plaintext';
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decoration: vscode.TextEditorDecorationType;
  private decorationTimer: ReturnType<typeof setTimeout> | undefined;
  public logger: { info(message: string): void } | undefined;

  public constructor() {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(255, 140, 66, 0.10)',
      borderColor: 'rgba(255, 140, 66, 0.85)',
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      overviewRulerColor: 'rgba(255, 140, 66, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.changeEmitter.event,
        provideTextDocumentContent: () => this.content,
      }),
      // The header path opens the REAL file for hand-editing.
      vscode.languages.registerDocumentLinkProvider(
        { scheme: SCHEME },
        {
          provideDocumentLinks: (document) => {
            const firstLine = document.lineAt(0).text;
            const match = /π (?:editing|reading): (\/[^\s]+)/.exec(firstLine);
            if (!match) {
              return [];
            }
            const at = firstLine.indexOf(match[1]!);
            return [
              new vscode.DocumentLink(
                new vscode.Range(0, at, 0, at + match[1]!.length),
                vscode.Uri.file(match[1]!)
              ),
            ];
          },
        }
      )
    );
  }

  /** Mirror the file π is on. Same URI every time → the SAME tab, updated in place. */
  public async show(activity: ScreenActivity): Promise<void> {
    const raw = await this.readWithRetry(activity.absolute);
    if (raw === undefined) {
      this.logger?.info(`[screen] ${activity.absolute} not on disk after retries`);
      return;
    }
    const language = languageForPath(activity.absolute);
    const prefix = headerPrefix(language);
    const verb = activity.kind === 'editing' ? 'editing' : 'reading';
    let body = raw;
    let clippedNote = '';
    let clipOffsetLines = 0;
    if (raw.length > MAX_MIRROR_CHARS) {
      // Window around the interesting region so huge files stay snappy.
      const lines = raw.split('\n');
      const focusLine = activity.needle
        ? Math.max(
            0,
            raw.slice(0, Math.max(0, raw.indexOf(activity.needle))).split('\n').length - 1
          )
        : Math.max(0, (activity.revealLine ?? 1) - 1);
      const start = Math.max(0, focusLine - 200);
      const end = Math.min(lines.length, focusLine + 400);
      clipOffsetLines = start;
      body = lines.slice(start, end).join('\n');
      clippedNote = ` · showing lines ${start + 1}–${end} of ${lines.length}`;
    }
    const header = `${prefix}π ${verb}: ${activity.absolute}  (${activity.chatTitle.trim()}${clippedNote})`;
    this.content = `${header}\n\n${body}`;
    this.changeEmitter.fire(SCREEN_URI);

    const editor = await vscode.window.showTextDocument(SCREEN_URI, {
      viewColumn: activity.column,
      preview: false, // same URI = same tab; preview heuristics irrelevant
      preserveFocus: true,
    });
    // If VS Code parked us in the chat's own group (layout quirks), say so
    // ONCE — dragging the π Screen tab right is remembered forever after.
    if (
      !this.warnedPlacement &&
      editor.viewColumn !== undefined &&
      activity.chatColumn !== undefined &&
      editor.viewColumn === activity.chatColumn
    ) {
      this.warnedPlacement = true;
      void vscode.window.showInformationMessage(
        'π Screen opened next to the chat — drag its tab to the right split once; the spot is remembered.'
      );
    }
    if (this.currentLanguage !== language) {
      this.currentLanguage = language;
      await vscode.languages.setTextDocumentLanguage(editor.document, language).then(
        () => undefined,
        () => undefined
      );
    }
    this.reveal(editor, activity, clipOffsetLines);
  }

  private reveal(
    editor: vscode.TextEditor,
    activity: ScreenActivity,
    clipOffsetLines: number
  ): void {
    const HEADER_LINES = 2;
    let range: vscode.Range | undefined;
    if (activity.needle) {
      const at = this.content.indexOf(activity.needle);
      if (at >= 0) {
        const startLine = this.content.slice(0, at).split('\n').length - 1;
        const endLine = startLine + activity.needle.split('\n').length - 1;
        range = new vscode.Range(startLine, 0, endLine, 0);
      }
    }
    if (!range && activity.revealLine !== undefined) {
      const line = Math.max(0, activity.revealLine - 1 - clipOffsetLines) + HEADER_LINES;
      range = new vscode.Range(line, 0, line, 0);
    }
    if (!range) {
      range = new vscode.Range(0, 0, 0, 0);
    }
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (activity.kind === 'editing') {
      editor.setDecorations(this.decoration, [
        {
          range,
          hoverMessage: new vscode.MarkdownString(
            `$(edit) edited by **π — ${activity.chatTitle.trim()}**`
          ),
        },
      ]);
      clearTimeout(this.decorationTimer);
      this.decorationTimer = setTimeout(() => editor.setDecorations(this.decoration, []), 7000);
    } else {
      editor.setDecorations(this.decoration, []);
    }
  }

  /** Fresh writes land on disk AFTER the tool call streams — retry briefly. */
  private async readWithRetry(absolute: string): Promise<string | undefined> {
    for (const delay of [0, 800, 2200]) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolute));
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch {
        /* not there yet */
      }
    }
    return undefined;
  }

  public dispose(): void {
    clearTimeout(this.decorationTimer);
    this.decoration.dispose();
    this.changeEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

export { SCREEN_URI };
