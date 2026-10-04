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
  /** Last-activity epoch ms. The RENDERER turns this into "5m ago" at paint
   * time (and repaints on an interval) — the host must NOT bake relative
   * time into `detail`, or the text goes stale between snapshots. Kept OUT
   * of the snapshot identity for the same reason detail's old timestamp
   * was: the active session's file mtime moves constantly. */
  modifiedAt?: number;
  /** Session file size (bytes) — rows past SIZE_WARN_BYTES paint a warning
   * so a 113MB unresumable session is visible weeks before it hurts. */
  sizeBytes?: number;
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

const UNKNOWN_RELATIVE_TIME = 'Unknown';

/** Browser-safe relative-time formatter — canonical home (the webview bundle
 * must render timestamps itself so they can refresh without a host push).
 * recentSessions.ts re-exports this as formatRelativeTimestamp for the
 * node-side consumers. */
export function formatRelativeTime(value: number, now = Date.now()): string {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(now)) {
    return UNKNOWN_RELATIVE_TIME;
  }
  const delta = Math.max(0, now - value);
  if (!Number.isFinite(delta)) {
    return UNKNOWN_RELATIVE_TIME;
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) {
    return 'just now';
  }
  if (delta < hour) {
    return `${Math.floor(delta / minute)}m ago`;
  }
  if (delta < day) {
    return `${Math.floor(delta / hour)}h ago`;
  }
  return `${Math.floor(delta / day)}d ago`;
}

export interface PendingDeletion {
  id: string;
}

/** Keep rows hidden while a delete is in flight, including during a slow scan.
 * The host ends each pending operation explicitly on success or failure. */
export function applyPendingDeletions(
  model: ChatListModel,
  pending: PendingDeletion[]
): ChatListRow[] {
  if (pending.length === 0) {
    return model.rows;
  }
  const hidden = new Set(pending.map((entry) => entry.id));
  return model.rows.filter(
    (row) =>
      !(row.sessionPath && hidden.has(row.sessionPath)) &&
      !(row.openCommand.resource && hidden.has(row.openCommand.resource))
  );
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
    return {
      push: false,
      lastIdentity: state.lastIdentity,
      hasShownRealData: state.hasShownRealData,
    };
  }
  // Title IS part of identity (a rename or a late-arriving first-prompt
  // preview changes the visible text with the same row ids — must re-push).
  // Detail stays OUT: it embeds wall-clock-relative text ("5m ago"), the
  // original reload-flash bug this diff exists to prevent.
  const identity = JSON.stringify(
    model.rows.map((row) => [
      row.id,
      row.active,
      row.sessionPath ?? '',
      row.favorite === true,
      row.title,
    ])
  );
  if (identity === state.lastIdentity && !model.loading && state.hasShownRealData) {
    return {
      push: false,
      lastIdentity: state.lastIdentity,
      hasShownRealData: state.hasShownRealData,
    };
  }
  return {
    push: true,
    lastIdentity: identity,
    hasShownRealData: state.hasShownRealData || !model.loading,
  };
}
