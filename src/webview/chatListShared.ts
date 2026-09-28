// Browser-safe, no-node-dependency slice of the Agentic Mode chat list logic
// — importable from chatList.ts (the webview bundle, esbuild platform:
// 'browser') without dragging node:fs/node:readline into that bundle.
//
// This split exists because of a real build break: chatListData.ts (the
// OTHER half, used by the extension host) imports formatRelativeTimestamp
// from sessions/recentSessions.ts, which needs node:fs/node:readline to
// scan session files — fine for the extension host (platform: 'node'), fatal
// for a browser bundle. As long as chatList.ts only imported TYPES from
// chatListData.ts, TypeScript erased them at compile time and esbuild never
// saw a runtime dependency on recentSessions.ts at all. The moment
// chatList.ts needed a real FUNCTION from that file (buildDeleteMessage,
// added to fix "delete doesn't seem to work"), esbuild had to bundle the
// whole module for real — including its node-only transitive import — and
// the browser build failed outright. Keep anything chatList.ts calls (not
// just types it references) in THIS file, never the other one.

export interface ChatListRow {
  id: string;
  title: string;
  detail?: string;
  active: boolean;
  isOpen: boolean;
  /** Starred by the user (hover star icon); favorites float to the top of
   * their block and keep a visible filled star. Only rows with a real
   * session file can be favorited (the star is keyed by sessionPath). */
  favorite?: boolean;
  openCommand: { resource?: string; sessionPath?: string; label?: string };
  sessionPath?: string;
}

export interface ChatListModel {
  rows: ChatListRow[];
  loading: boolean;
  error?: string;
}

export type DeleteChatMessage =
  | { type: 'deleteChat'; sessionPath: string }
  | { type: 'deleteChat'; resource: string };

/** What to send when deleting a row. A row with no session file yet (a
 * fresh draft, never persisted) has nothing on disk for
 * piRpcInternal.deleteSession to remove; without this fallback, deleting
 * one silently did nothing at all (reported as "delete doesn't seem to
 * work") — closing its tab is the only meaningful action left. A recent
 * (not open) row always comes from an on-disk session file, so it always
 * has sessionPath in practice; returning undefined for a row that's
 * neither open nor has a path is a defensive no-op, not a real case. */
export function buildDeleteMessage(row: ChatListRow): DeleteChatMessage | undefined {
  if (row.sessionPath) {
    return { type: 'deleteChat', sessionPath: row.sessionPath };
  }
  if (row.isOpen && row.openCommand.resource) {
    return { type: 'deleteChat', resource: row.openCommand.resource };
  }
  return undefined;
}

export interface PendingDeletion {
  id: string;
  startedAt: number;
}

/** Deleting a chat deletes its file immediately, but the row only actually
 * disappears from the list once RecentSessionService's full sessions-dir
 * rescan completes and reports the shorter list back — and that rescan is
 * DELIBERATELY never awaited before returning (a full directory scan is
 * slow; blocking the UI on it would be worse), so the row visibly lingers
 * until it finishes in the background. Reported as "takes a while to
 * remove the deleted item".
 *
 * Fix: hide it from the model immediately (we already know it's gone —
 * we just deleted it), and self-heal once the real data catches up:
 *  - not in the model anymore → confirmed gone for real, stop tracking it.
 *  - still in the model past `timeoutMs` → give up hiding it; if the
 *    delete actually failed, the user should see the stale entry again
 *    rather than have it vanish from view forever with no explanation. */
export function applyPendingDeletions(
  model: ChatListModel,
  pending: PendingDeletion[],
  now: number,
  timeoutMs = 5000
): { rows: ChatListRow[]; stillPending: PendingDeletion[] } {
  if (pending.length === 0) {
    return { rows: model.rows, stillPending: pending };
  }
  const idsInModel = new Set(
    model.rows.flatMap((row) =>
      [row.sessionPath, row.openCommand.resource].filter((value): value is string => Boolean(value))
    )
  );
  const stillPending = pending.filter((entry) => idsInModel.has(entry.id) && now - entry.startedAt <= timeoutMs);
  if (stillPending.length === 0) {
    return { rows: model.rows, stillPending };
  }
  const hidden = new Set(stillPending.map((entry) => entry.id));
  const rows = model.rows.filter(
    (row) =>
      !(row.sessionPath && hidden.has(row.sessionPath)) &&
      !(row.openCommand.resource && hidden.has(row.openCommand.resource))
  );
  return { rows, stillPending };
}

export interface SnapshotDecisionState {
  lastIdentity?: string;
  hasShownRealData: boolean;
}

export interface SnapshotDecision extends SnapshotDecisionState {
  push: boolean;
}

/** Decides whether a freshly-built model is worth posting to the webview.
 *
 * Two real bugs lived here:
 *  1. Diffing rendered TEXT (not stable identity) meant wall-clock-relative
 *     strings like "5m ago" could register as "changed" on their own.
 *  2. RecentSessionService.refresh() fires its change event TWICE — once
 *     with loading:true, once with the result — and EVERY open of a Recent
 *     chat calls refresh() explicitly. Letting the loading:true tick
 *     through blanked an already-populated list to "Loading chats…" and
 *     back, which is exactly what read as "opening a chat reloads the
 *     list". Only the true first-ever load (nothing shown yet) should
 *     surface a loading state at all. */
export function decideSnapshotPush(
  model: ChatListModel,
  state: SnapshotDecisionState
): SnapshotDecision {
  if (model.loading && state.hasShownRealData) {
    return { push: false, lastIdentity: state.lastIdentity, hasShownRealData: state.hasShownRealData };
  }
  // Title IS part of identity (a rename or a late-arriving first-prompt
  // preview changes the visible text with the same row ids — must re-push).
  // Detail stays OUT: it embeds wall-clock-relative text ("5m ago"), the
  // original reload-flash bug this diff exists to prevent.
  const identity = JSON.stringify(
    model.rows.map((row) => [row.id, row.active, row.sessionPath ?? '', row.favorite === true, row.title])
  );
  if (identity === state.lastIdentity && !model.loading) {
    return { push: false, lastIdentity: state.lastIdentity, hasShownRealData: state.hasShownRealData };
  }
  return {
    push: true,
    lastIdentity: identity,
    hasShownRealData: state.hasShownRealData || !model.loading,
  };
}
