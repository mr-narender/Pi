import type { RecentSessionRecord } from '../sessions/recentSessions';
import type { RecentSessionsState } from '../sessions/recentSessionService';
import type { ChatListModel, ChatListRow } from './chatListShared';

export type { ChatListModel, ChatListRow } from './chatListShared';

// Node-dependent half of the Agentic Mode chat list logic — needs
// formatRelativeTimestamp from sessions/recentSessions.ts (node:fs/
// node:readline under the hood), so this file is extension-host-only
// (agenticChatListHost.ts, platform: 'node'). See chatListShared.ts's own
// comment for why that split exists and why it's load-bearing, not
// stylistic — chatList.ts (the webview bundle) must import row-building
// logic from THAT file, never this one.
//
// Real "open" data source is ChatTabManager.listOpenChats() (passed in
// already-mapped), not the recent-sessions array — see the git history for
// why that distinction matters (two earlier attempts showed near-duplicate
// content because both drew from the same array).
//
// Icon rule, per explicit feedback: exactly TWO visual states, not three —
// the active/current chat gets a check mark, everything else (whether an
// open-but-not-focused tab or plain history) gets ONE consistent chat icon.
// `isOpen` is still tracked for the dedup logic below, just not used to
// pick a third icon variant.
export interface OpenChatEntry {
  resource: string;
  title: string;
  sessionFile?: string;
  active: boolean;
}

export interface ChatListInput {
  openChats: OpenChatEntry[];
  recent: RecentSessionsState;
  /** Session file paths the user starred; favorites float to the top of
   * their block (open or history) and carry a filled star in the UI. */
  favorites?: ReadonlySet<string>;
  now?: number;
}

// The extension auto-names every new session "Session N" (tabManager's
// renameSession call on new-chat), and that generic name persists into the
// session file where it outranks the first prompt — which is why the list
// filled up with indistinguishable "Session 36" rows. For DISPLAY, demote
// the auto-pattern: prefer the user's actual first prompt as the
// recognizable identity. A genuine custom rename (anything not matching the
// exact auto-pattern) still wins. Display-layer only — the stored session
// name, tab titles, and the auto-rename itself are untouched.
const GENERIC_SESSION_NAME = /^Session \d+$/;

function sessionDisplayName(session: RecentSessionRecord): string {
  const named = [session.displayName, session.sessionName]
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
  const custom = named.find((name) => !GENERIC_SESSION_NAME.test(name));
  if (custom) {
    return custom;
  }
  const preview = session.firstPromptPreview?.trim();
  return preview || named[0] || 'Untitled chat';
}

export function buildChatListModel(input: ChatListInput): ChatListModel {
  const rows: ChatListRow[] = [];
  const favorites = input.favorites ?? new Set<string>();
  const favoriteRank = (path?: string): number => (path && favorites.has(path) ? 1 : 0);
  // Open chats form one block above history: favorites first, then
  // newest-first, matching the order of the recents block below.
  // OpenChatEntry carries no timestamp, so join to recents via sessionFile;
  // unknown time (brand-new session not yet indexed, or recents still
  // loading) sorts to the TOP of the block — a just-created chat is the
  // newest thing. Sort is stable, so ties and unknowns keep tab order (the
  // pre-sort behavior).
  const recordBySessionPath = new Map<string, RecentSessionRecord>();
  for (const session of input.recent.items) {
    recordBySessionPath.set(session.path, session);
  }
  const openChatTime = (chat: OpenChatEntry): number => {
    const t = chat.sessionFile ? recordBySessionPath.get(chat.sessionFile)?.modifiedAt : undefined;
    // Same "known timestamp" rule as recentSessions.ts (finite and > 0).
    return t !== undefined && Number.isFinite(t) && t > 0 ? t : Number.MAX_SAFE_INTEGER;
  };
  // Search filter: the recents in input.recent.items arrive PRE-filtered by
  // RecentSessionService (setFilter → filterRecentSessions over name/preview/
  // workspace/model/id), so only the open block needs filtering here — by
  // the same title the row will actually display.
  const query = input.recent.filterText.trim().toLowerCase();
  const sortedOpenChats = [...input.openChats].sort(
    (a, b) =>
      favoriteRank(b.sessionFile) - favoriteRank(a.sessionFile) || openChatTime(b) - openChatTime(a)
  );
  for (const chat of sortedOpenChats) {
    // Prefer the indexed session's resolved name (first-prompt preview et
    // al) over the raw tab title ("Session 36"); keep the tab title when
    // the record can't produce anything better.
    const record = chat.sessionFile ? recordBySessionPath.get(chat.sessionFile) : undefined;
    const resolved = record ? sessionDisplayName(record) : undefined;
    const title = resolved && resolved !== 'Untitled chat' ? resolved : chat.title;
    if (query && !title.toLowerCase().includes(query)) {
      continue;
    }
    rows.push({
      id: `open:${chat.resource}`,
      title,
      modifiedAt: record?.modifiedAt,
      sizeBytes: record?.sizeBytes,
      active: chat.active,
      isOpen: true,
      favorite: favoriteRank(chat.sessionFile) === 1,
      openCommand: { resource: chat.resource },
      sessionPath: chat.sessionFile,
    });
  }

  if (input.recent.loading) {
    return { rows, loading: true };
  }
  if (input.recent.error) {
    return { rows, loading: false, error: input.recent.error };
  }

  const openSessionFiles = new Set(
    input.openChats.map((chat) => chat.sessionFile).filter((path): path is string => Boolean(path))
  );
  // Favorites sort BEFORE the 20-row cap so a starred chat can never age
  // out of the list; the stable sort keeps newest-first order inside both
  // the favorite and non-favorite groups.
  const visibleRecents = input.recent.items
    .filter((s) => !openSessionFiles.has(s.path))
    .sort((a, b) => favoriteRank(b.path) - favoriteRank(a.path))
    .slice(0, 20);
  for (const session of visibleRecents) {
    const title = sessionDisplayName(session);
    rows.push({
      id: `recent:${session.id}`,
      title,
      // Relative time is NOT baked in here — the renderer formats
      // modifiedAt at paint time so "5m ago" can refresh client-side.
      detail: session.workspaceLabel || undefined,
      modifiedAt: session.modifiedAt,
      sizeBytes: session.sizeBytes,
      active: false,
      isOpen: false,
      favorite: favoriteRank(session.path) === 1,
      openCommand: { sessionPath: session.path, label: title },
      sessionPath: session.path,
    });
  }

  return { rows, loading: false };
}
