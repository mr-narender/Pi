// Pure helpers for display-time code formatting (host extracts + formats via
// VS Code's registered formatters; the webview looks results up by key).
// vscode-free so unit tests can drive every rule.
import { fingerprint } from './composer';

/** Blocks larger than this are never sent to a formatter (display latency). */
export const FORMAT_MAX_CHARS = 20_000;

export function formatKey(language: string | undefined, code: string): string {
  return `${(language ?? '').trim().toLowerCase()}:${fingerprint(code)}:${code.length}`;
}

export function isFormattableBlock(language: string | undefined, code: string): boolean {
  void language;
  return code.trim().length > 0 && code.length <= FORMAT_MAX_CHARS;
}

export interface FencedBlock {
  language: string;
  code: string;
}

/**
 * Extract fenced code blocks (```lang … ```) from message markdown for the
 * host-side formatting pass. JSON-ish fences are skipped — the renderer shows
 * those as structured JSON tables, never as formatted code.
 */
const JSON_TABLE_FENCE_LANGS = new Set(['', 'json', 'json5', 'jsonc', 'text', 'txt', 'output']);

function rendersAsJsonTable(language: string, code: string): boolean {
  if (!JSON_TABLE_FENCE_LANGS.has(language)) {
    return false;
  }
  const trimmed = code.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

export function collectCodeFences(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const open = /^```(\S*)\s*$/.exec(lines[index] ?? '');
    if (!open) {
      index += 1;
      continue;
    }
    const language = (open[1] ?? '').toLowerCase();
    index += 1;
    const code: string[] = [];
    while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
      code.push(lines[index] ?? '');
      index += 1;
    }
    index += 1; // closing fence (or EOF)
    const codeText = code.join('\n');
    if (!rendersAsJsonTable(language, codeText) && isFormattableBlock(language, codeText)) {
      blocks.push({ language, code: codeText });
    }
  }
  return blocks;
}

export interface PositionLike {
  line: number;
  character: number;
}

export interface TextEditLike {
  range: { start: PositionLike; end: PositionLike };
  newText: string;
}

/**
 * Apply VS Code TextEdits to a plain string (no TextDocument needed): convert
 * line/character positions to offsets and apply non-overlapping edits from the
 * end backwards so earlier offsets stay valid.
 */
export function applyTextEditsToString(text: string, edits: TextEditLike[]): string {
  if (edits.length === 0) {
    return text;
  }
  // Line-start offsets for position→offset conversion.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  const toOffset = (position: PositionLike): number => {
    if (position.line >= lineStarts.length) {
      return text.length;
    }
    const lineStart = lineStarts[Math.max(0, position.line)] ?? 0;
    const lineEnd =
      lineStarts[position.line + 1] !== undefined
        ? lineStarts[position.line + 1]! - 1
        : text.length;
    return Math.min(lineStart + Math.max(0, position.character), lineEnd);
  };
  const resolved = edits
    .map((edit) => ({
      start: toOffset(edit.range.start),
      end: toOffset(edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  for (const edit of resolved) {
    result =
      result.slice(0, edit.start) + edit.newText + result.slice(Math.max(edit.start, edit.end));
  }
  return result;
}
