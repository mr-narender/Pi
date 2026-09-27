// Minimal frontmatter reader for SKILL.md / prompt template .md files.
// Deliberately NOT a YAML library: every field Pi's own docs show (name,
// description, argument-hint, license, etc.) is a single-line `key: value`
// pair between two `---` fences — no nesting, no lists. A hand-rolled
// line parser covers the real shape exactly, matching the zero-dependency
// pattern already used elsewhere in this codebase (live/importScan.ts).
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return {};
  }
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    if (line.trim() === '---') {
      break;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue; // not a key: value line — skip rather than fail the whole file
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip one layer of matching quotes (argument-hint: "[focus]" in the docs' own example).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      fields[key] = value;
    }
  }
  return fields;
}

/** Prompt templates: description falls back to the first non-empty line
 * after the frontmatter when omitted — exact rule from prompt-templates.md. */
export function firstNonEmptyLineAfterFrontmatter(content: string): string | undefined {
  const lines = content.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i]?.trim() !== '---') {
      i++;
    }
    i++; // past the closing fence
  }
  for (; i < lines.length; i++) {
    const trimmed = lines[i]?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
