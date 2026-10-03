// Pure — no vscode import — so it's directly unit-testable, same split as
// review/hunks.ts vs review/inlineReview.ts elsewhere in this codebase.
//
// Third-party Pi extensions (installed skills/tools running inside the
// agent process) can set arbitrary status text via the extension-UI
// protocol — some of them format that text for TERMINAL rendering and
// include raw ANSI color codes (e.g. "\x1b[38;5;109m...\x1b[39m"), which a
// VS Code status bar does not interpret, so they show up as garbled literal
// text ("[38;5;109m..."). Not a bug in what this extension sends, but this
// extension is what's rendering it, so stripping defensively is the right
// move regardless of whose text it originally was.
export function stripAnsiCodes(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
