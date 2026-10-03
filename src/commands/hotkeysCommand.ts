import * as vscode from 'vscode';

/** GUI help is local; native VS Code resolves user overrides, not a binding parser. */
export async function hotkeysCommand(args: string, valid: () => boolean): Promise<boolean> {
  if (args) throw new Error('/hotkeys does not accept arguments.');
  if (!valid()) throw new Error('The originating chat changed; shortcut help cancelled.');
  const choice = await vscode.window.showInformationMessage(
    'Pi GUI Shortcuts',
    {
      modal: true,
      detail: [
        'VS Code command bindings: open Keyboard Shortcuts filtered to this extension. User overrides and when clauses are authoritative there; no effective bindings are inferred here.',
        'Composer-only behavior (not configurable VS Code keybindings):',
        'Shift+Tab: native thinking cycle (piRpc.cycleThinkingLevel), including while busy, on the current ready/busy chat. No repeat; Ctrl/Meta/Alt or IME Shift+Tab is left alone.',
        'Enter: activate the enabled send action (prompt when idle; queue a follow-up with Send next while busy). There is no dedicated composer steering/dequeue shortcut.',
        'Shift+Enter: newline. Cmd/Ctrl+Enter: send with one-shot follow requested (ordinary prompts only; local commands do not arm follow). IME Enter does not submit.',
        'Open slash/file completion: Up/Down select, Enter or Tab accepts, Escape closes. Completion takes priority over send/history; completion handlers do not have an IME guard. Shift+Tab cycles thinking before completion. Tab without completion uses normal focus traversal.',
        'Up at the start of the composer browses older prompt history; Down while browsing moves forward (outside IME).',
        'Native Pi TUI shortcuts are terminal-only: its keybindings.json and /hotkeys display are not GUI bindings. No terminal model-cycle, dequeue, external-editor or suspend shortcut is promised here.',
      ].join('\n\n'),
    },
    'Done',
    'Keyboard Shortcuts'
  );
  if (!valid()) throw new Error('The originating chat changed; shortcut help cancelled.');
  if (choice === 'Done') return true;
  if (choice !== 'Keyboard Shortcuts') return false;
  await vscode.commands.executeCommand(
    'workbench.action.openGlobalKeybindings',
    '@ext:mr-narender.pi'
  );
  return valid();
}
