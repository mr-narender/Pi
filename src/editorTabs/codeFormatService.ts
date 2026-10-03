// Display-time code formatting via the user's OWN registered VS Code
// formatters (any language with a formatter installed just works). Formatting
// is best-effort and display-only: the stored conversation never changes, a
// missing/slow formatter simply leaves the block as-is.
import * as vscode from 'vscode';
import {
  type FencedBlock,
  applyTextEditsToString,
  formatKey,
  isFormattableBlock,
} from '../webview/codeFormat';
import { vscodeLanguageId } from './languageId';

const FORMAT_TIMEOUT_MS = 800;
const CACHE_MAX_ENTRIES = 300;

export class CodeFormatService {
  /** key → formatted text (string) or null (attempted; keep original). */
  private readonly cache = new Map<string, string | null>();
  private readonly pending = new Set<string>();

  public constructor(private readonly onDidFormat: () => void) {}

  /** Formatted results available right now, for embedding into a snapshot. */
  public snapshotMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [key, value] of this.cache) {
      if (typeof value === 'string') {
        map[key] = value;
      }
    }
    return map;
  }

  /** Queue unseen blocks for background formatting. Safe to call every render. */
  public request(blocks: FencedBlock[]): void {
    for (const block of blocks) {
      if (!isFormattableBlock(block.language, block.code)) {
        continue;
      }
      const key = formatKey(block.language, block.code);
      if (this.cache.has(key) || this.pending.has(key)) {
        continue;
      }
      this.pending.add(key);
      void this.format(key, block.language, block.code);
    }
  }

  private async format(key: string, language: string, code: string): Promise<void> {
    let changed = false;
    try {
      const languageId = vscodeLanguageId(language);
      if (!languageId) {
        this.cache.set(key, null);
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ language: languageId, content: code });
      const edits = await Promise.race([
        vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
          'vscode.executeFormatDocumentProvider',
          doc.uri,
          { insertSpaces: true, tabSize: 2 }
        ),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), FORMAT_TIMEOUT_MS)
        ),
      ]);
      if (!edits || edits.length === 0) {
        this.cache.set(key, null);
        return;
      }
      const formatted = applyTextEditsToString(code, edits);
      changed = formatted !== code && formatted.trim().length > 0;
      this.cache.set(key, changed ? formatted : null);
    } catch {
      this.cache.set(key, null);
    } finally {
      this.pending.delete(key);
      this.evict();
      if (changed) {
        this.onDidFormat();
      }
    }
  }

  private evict(): void {
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.cache.delete(oldest);
    }
  }
}
