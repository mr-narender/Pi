// One menu for both Chat and Agentic sidebar modes. The host accepts only
// commands listed here; never execute an arbitrary command from a webview.
export const CHAT_ACTION_COMMANDS = [
  'piRpc.reviewLastTurn',
  'piRpc.showChatVersions',
  'piRpc.exportHtml',
  'piRpc.manageExtensions',
  'piRpc.manageSkills',
  'piRpc.managePrompts',
  'piRpc.manageAgentInstructions',
  'piRpcInternal.restart',
] as const;

export function isChatActionCommand(
  value: unknown
): value is (typeof CHAT_ACTION_COMMANDS)[number] {
  return typeof value === 'string' && CHAT_ACTION_COMMANDS.some((command) => command === value);
}

export function renderChatActionsMenu(agentic = false): string {
  return `<details class="menu-details sb-more"><summary class="sb-btn" data-tooltip="More actions" aria-label="More actions"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg></summary><div class="menu-panel" role="menu"><div class="menu-group">Chat</div>${agentic ? '<button type="button" class="menu-item" data-switch-chat>Switch to full chat</button>' : ''}<button type="button" class="menu-item" data-command="piRpc.reviewLastTurn">Review last turn</button><button type="button" class="menu-item" data-command="piRpc.showChatVersions">Chat versions</button><button type="button" class="menu-item" data-command="piRpc.exportHtml">Export chat</button><div class="menu-group">Configure</div>${agentic ? '<button type="button" class="menu-item" data-agentic-theme>Theme…</button>' : ''}<button type="button" class="menu-item" data-command="piRpc.manageExtensions">Extensions…</button><button type="button" class="menu-item" data-command="piRpc.manageSkills">Skills…</button><button type="button" class="menu-item" data-command="piRpc.managePrompts">Prompts…</button><button type="button" class="menu-item" data-command="piRpc.manageAgentInstructions">Agent instructions…</button><div class="menu-group">System</div><button type="button" class="menu-item" data-command="piRpcInternal.restart">Restart π</button></div></details>`;
}
