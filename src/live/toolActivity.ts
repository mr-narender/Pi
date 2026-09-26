// Pure mapping: tool call → file activity (what is π touching right now?).
// Kept vscode-free so unit tests can exercise it directly.
import { editToolFilePath } from '../webview/editToolPath';

export interface ToolActivity {
  kind: 'editing' | 'reading';
  path: string;
}

function argsPath(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['path', 'file_path', 'filePath', 'file', 'target_file']) {
        if (typeof record[key] === 'string' && record[key]) {
          return record[key] as string;
        }
      }
    }
  } catch {
    /* tolerate partial/streaming JSON */
  }
  return undefined;
}

/** Classify a tool call as file activity. Edits win over reads. */
export function toolActivity(
  name: string | undefined,
  args: string | undefined
): ToolActivity | undefined {
  if (!name) {
    return undefined;
  }
  const editPath = editToolFilePath(name, args);
  if (editPath) {
    return { kind: 'editing', path: editPath };
  }
  const lower = name.toLowerCase();
  const isReadTool =
    lower === 'read' ||
    lower === 'read_file' ||
    lower.includes('read_file') ||
    lower === 'cat' ||
    lower === 'open_file';
  if (isReadTool) {
    const path = argsPath(args);
    if (path) {
      return { kind: 'reading', path };
    }
  }
  return undefined;
}

/** Best-effort text to locate the edited region once the change lands. */
export function revealNeedle(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const candidate =
        (typeof record.newString === 'string' && record.newString) ||
        (typeof record.new_str === 'string' && record.new_str) ||
        (typeof record.content === 'string' && record.content) ||
        '';
      const line = candidate
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => entry.length >= 8);
      return line?.slice(0, 120);
    }
  } catch {
    /* streaming args */
  }
  return undefined;
}

/** Line the agent started reading at (read tools carry offset/startLine). */
export function readStartLine(args: string | undefined): number | undefined {
  if (!args) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['offset', 'startLine', 'start_line']) {
        const value = record[key];
        if (typeof value === 'number' && value > 0) {
          return Math.floor(value);
        }
      }
    }
  } catch {
    /* streaming args */
  }
  return undefined;
}

const FS_EXCLUDE = [
  '/node_modules/',
  '/.git/',
  '/dist/',
  '/out/',
  '/build/',
  '/coverage/',
  '/.vscode-test/',
  '/.tmp/',
  '/__pycache__/',
  '/.venv/',
  '/vendor/',
];
const FS_EXCLUDE_SUFFIX = ['.log', '.lock', '.tmp', '.map', '.vsix', '.DS_Store'];

/** FS-truth tracking filter: is this changed file worth following? */
export function shouldTrackFsPath(fsPath: string, roots: string[]): boolean {
  if (!roots.some((root) => root && fsPath.startsWith(root.endsWith('/') ? root : `${root}/`))) {
    return false;
  }
  const normalized = fsPath.replaceAll('\\', '/');
  if (FS_EXCLUDE.some((part) => normalized.includes(part))) {
    return false;
  }
  if (FS_EXCLUDE_SUFFIX.some((suffix) => normalized.endsWith(suffix))) {
    return false;
  }
  const base = normalized.split('/').pop() ?? '';
  if (base.startsWith('.')) {
    return false;
  }
  return true;
}

/** The text π is working AT right now — the old text still present in the file
 * during a streaming edit (best live anchor), else the new text. */
export function anchorNeedle(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['oldString', 'old_str', 'newString', 'new_str', 'content', 'appendContent']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
          const line = value
            .split('\n')
            .map((entry) => entry.trim())
            .find((entry) => entry.length >= 6);
          if (line) {
            return line.slice(0, 120);
          }
        }
      }
    }
  } catch {
    /* streaming */
  }
  return undefined;
}
