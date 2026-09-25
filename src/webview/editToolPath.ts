// Pure (vscode-free) helper: given a tool name and its stringified args, return
// the target file path if this is a file-editing tool (Pi's `edit` / `write`).
// Used to offer "Open file" / "Open changes" actions on edit tool cards.

export interface EditReplacement {
  oldText: string;
  newText: string;
}

// Extract the {oldText,newText} replacements from an `edit` tool's args so the
// UI can render a real +/- diff instead of raw JSON.
export function editReplacements(
  toolName: string | undefined,
  args: string | undefined
): EditReplacement[] {
  if (!toolName || !args) {
    return [];
  }
  const name = toolName.toLowerCase();
  if (name !== 'edit' && !name.includes('edit') && !name.includes('str_replace')) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(args);
    if (!parsed || typeof parsed !== 'object') {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    // Pi's edit tool speaks several dialects: single {oldString,newString},
    // batch edits[], appendContent, symbol+content — plus the legacy
    // {oldText,newText} and replacements[] shapes.
    const single = (entry: Record<string, unknown>): boolean =>
      ['oldText', 'newText', 'oldString', 'newString', 'appendContent', 'content'].some(
        (key) => typeof entry[key] === 'string'
      );
    const rawList = Array.isArray(record.replacements)
      ? record.replacements
      : Array.isArray(record.edits)
        ? record.edits
        : single(record)
          ? [record]
          : [];
    const out: EditReplacement[] = [];
    for (const item of rawList) {
      if (item && typeof item === 'object') {
        const entry = item as Record<string, unknown>;
        const pick = (...keys: string[]): string => {
          for (const key of keys) {
            if (typeof entry[key] === 'string') {
              return entry[key] as string;
            }
          }
          return '';
        };
        const oldText = pick('oldText', 'oldString');
        const newText = pick('newText', 'newString', 'appendContent', 'content');
        if (oldText || newText) {
          out.push({ oldText, newText });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function editToolFilePath(
  toolName: string | undefined,
  args: string | undefined
): string | undefined {
  if (!toolName || !args) {
    return undefined;
  }
  const name = toolName.toLowerCase();
  const isEditTool =
    name === 'edit' ||
    name === 'write' ||
    name.includes('edit_file') ||
    name.includes('write_file') ||
    name.includes('str_replace') ||
    name.includes('apply_patch');
  if (!isEditTool) {
    return undefined;
  }
  // Prefer structured parse.
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const candidate = record.path ?? record.file_path ?? record.filePath ?? record.filename;
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
  } catch {
    /* args may not be valid JSON — fall through to regex */
  }
  const match = /"(?:path|file_path|filePath|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args);
  if (match?.[1]) {
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }
  return undefined;
}

/** Per-change approval units: every edit tool call in the NEWEST assistant
 * turn, as { path, oldText, newText } — the pane renders Keep/Undo/Edit for
 * each. Pure so tests can drive it directly. */
export function deriveScreenChanges(
  messages: Array<{
    role: string;
    blocks?: Array<{ kind: string; name?: string; args?: string; callId?: string }>;
  }>
): Array<{ callId: string; path: string; oldText: string; newText: string }> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      break;
    }
    if (message.role !== 'assistant') {
      continue;
    }
    const changes: Array<{ callId: string; path: string; oldText: string; newText: string }> = [];
    for (const block of message.blocks ?? []) {
      if (block.kind !== 'tool' || !('name' in block)) {
        continue;
      }
      const path = editToolFilePath(block.name, block.args);
      if (!path) {
        continue;
      }
      for (const [at, replacement] of editReplacements(block.name, block.args).entries()) {
        changes.push({
          callId: `${block.callId ?? 'call'}-${at}`,
          path,
          oldText: replacement.oldText ?? '',
          newText: replacement.newText ?? '',
        });
      }
    }
    if (changes.length > 0) {
      return changes.slice(-12);
    }
  }
  return [];
}
