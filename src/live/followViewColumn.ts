// Pure decision logic for agentFollow.ts's showInSidePane — no vscode
// import, directly unit-testable.
//
// The real bug this exists to fix: showInSidePane used to SKIP opening the
// followed file entirely whenever a π chat tab owned the active editor
// group, with the comment "with the sidebar chat the center is always
// free" — true when the chat lived in the sidebar webview, but
// editorTabsEnabled() has been the default for a while (chat itself is an
// editor tab). In the common single-group layout, the chat tab IS the
// active tab in the only group whenever the user is looking at it — so
// that guard always fired, and follow silently never opened anything.
// Reported as "file tracking/following not seems to be working" — it
// wasn't broken, it was refusing to run at all.
//
// The fix isn't to remove the guard (it exists to avoid REPLACING the chat
// tab with the followed file in the same spot) — it's to redirect: reuse
// an existing non-chat group if one's already open (e.g. the user manually
// split), otherwise open a new one beside the chat.
export type FollowViewColumnChoice =
  | { kind: 'active' }
  | { kind: 'reuse'; groupIndex: number }
  | { kind: 'beside' };

export interface FollowGroupInfo {
  isChatOwned: boolean;
}

export function chooseFollowViewColumn(
  activeGroupIsChatOwned: boolean,
  otherGroups: FollowGroupInfo[]
): FollowViewColumnChoice {
  if (!activeGroupIsChatOwned) {
    // Already a normal files group (or no chat involved) — unchanged,
    // proven behavior: open right where the agent's activity is visible.
    return { kind: 'active' };
  }
  const reusableIndex = otherGroups.findIndex((group) => !group.isChatOwned);
  if (reusableIndex !== -1) {
    return { kind: 'reuse', groupIndex: reusableIndex };
  }
  return { kind: 'beside' };
}
