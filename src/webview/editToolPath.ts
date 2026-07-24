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
    const rawList = Array.isArray(record.replacements)
      ? record.replacements
      : typeof record.oldText === 'string' || typeof record.newText === 'string'
        ? [record]
        : [];
    const out: EditReplacement[] = [];
    for (const item of rawList) {
      if (item && typeof item === 'object') {
        const entry = item as Record<string, unknown>;
        const oldText = typeof entry.oldText === 'string' ? entry.oldText : '';
        const newText = typeof entry.newText === 'string' ? entry.newText : '';
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
