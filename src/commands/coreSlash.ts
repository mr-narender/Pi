/** Native 0.99.1 core spellings. Reservation is NOT implementation/discovery. */
export const CORE_SLASH_NAMES = [
  'settings',
  'model',
  'tree',
  'thinking',
  'scoped-models',
  'export',
  'import',
  'share',
  'bug',
  'copy',
  'name',
  'session',
  'changelog',
  'hotkeys',
  'fork',
  'clone',
  'trust',
  'login',
  'logout',
  'new',
  'compact',
  'resume',
  'reload',
  'quit',
  'debug',
  'arminsayshi',
  'dementedelves',
] as const;

export type CoreSlashName = (typeof CORE_SLASH_NAMES)[number];
export interface CoreSlashOperation {
  name: CoreSlashName;
  /** Trimmed remainder, deliberately not tokenized: native grammars differ. */
  args: string;
}

const reservedNames: ReadonlySet<string> = new Set(CORE_SLASH_NAMES);

/** Bare commands whose existing GUI handler starts an explicit picker/dialog.
 * Lifecycle actions and direct mutations deliberately remain completion-only. */
const menuNames: ReadonlySet<string> = new Set([
  'model',
  'settings',
  'thinking',
  'scoped-models',
  'name',
  'session',
  'hotkeys',
  'changelog',
  'export',
  'debug',
  'login',
  'logout',
  'share',
  'bug',
  'tree',
  'trust',
  'reload',
  'compact',
  'fork',
  'resume',
]);
export function isCoreMenuCommand(text: string): boolean {
  const operation = parseCoreSlash(text);
  return !!operation && !operation.args && menuNames.has(operation.name);
}

export function parseCoreSlash(text: string): CoreSlashOperation | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !reservedNames.has(match[1]!)) {
    return undefined;
  }
  return { name: match[1] as CoreSlashName, args: (match[2] ?? '').trim() };
}

/** Final safety boundary, including callers outside either composer. */
export function assertNotCoreSlashPrompt(text: string): void {
  const operation = parseCoreSlash(text);
  if (operation) {
    throw new Error(
      `/${operation.name} is a local GUI command and is not implemented yet. ` +
        'Your draft and attachments have not been submitted.'
    );
  }
}
