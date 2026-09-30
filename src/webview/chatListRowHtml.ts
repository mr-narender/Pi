// Pure string renderer for the Agentic Mode chat list — browser-safe, no
// vscode API, no DOM, no node imports. Split out of media/chatList.ts so the
// exact HTML the webview paints is golden-testable from node (the name-squeeze
// regression shipped precisely because this markup had zero coverage).
// media/chatList.ts owns wiring (postMessage, listeners) and MUST render
// through these functions only — new markup goes here, with a golden.
import { formatRelativeTime, type ChatListModel, type ChatListRow } from './chatListShared';
import { renderChatActionsMenu } from './chatActionsMenu';

const ICON_NEW_CHAT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 6V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1v2l3-2h1"/><path d="M12 9v5M9.5 11.5h5"/></svg>';
const ICON_SWITCH =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5h11m-3-3 3 3-3 3M13.5 11h-11m3-3-3 3 3 3"/></svg>';
const ICON_DIFF =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M8 2v12M4 6h2m-1-1v2m5 4h2"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>';
const ICON_CHAT =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H8l-3.2 2.6a.5.5 0 0 1-.8-.4V11h-.5A1.5 1.5 0 0 1 2 9.5v-6Z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.5 8a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.5-8"/></svg>';
const STAR_PATH = 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6L8 1.8z';
const ICON_STAR = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
const ICON_STAR_FILLED = `<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
const ICON_PENCIL =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.1 2.4a1.4 1.4 0 0 1 2 2L5.6 11.9l-2.8.8.8-2.8 7.5-7.5z"/></svg>';

export function escapeChatListHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

const esc = escapeChatListHtml;

/** Sessions past this size resume slowly or hit context/tooling limits —
 * surface it while it's still just a warning (a real 113MB session was
 * fully unresumable). */
export const SIZE_WARN_BYTES = 50 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function rowDetailText(row: ChatListRow, now: number): string | undefined {
  // Relative time is composed at PAINT time (not baked in by the host) so
  // the webview can repaint "5m ago" on an interval without a snapshot
  // push. Unknown/invalid timestamps are omitted entirely rather than
  // showing "Unknown".
  const hasTime =
    typeof row.modifiedAt === 'number' && Number.isFinite(row.modifiedAt) && row.modifiedAt > 0;
  const parts = [row.detail, hasTime ? formatRelativeTime(row.modifiedAt!, now) : undefined];
  const text = parts.filter(Boolean).join(' · ');
  return text || undefined;
}

function rowSizeWarning(row: ChatListRow): string {
  const oversized =
    typeof row.sizeBytes === 'number' &&
    Number.isFinite(row.sizeBytes) &&
    row.sizeBytes >= SIZE_WARN_BYTES;
  if (!oversized) {
    return '';
  }
  const label = `Large session file (${formatMegabytes(row.sizeBytes!)}) — may resume slowly; consider starting a fresh chat`;
  return `<span class="chat-list-row-size-warn" data-tooltip="${esc(label)}" aria-label="${esc(label)}">⚠ ${esc(formatMegabytes(row.sizeBytes!))}</span>`;
}

export function renderChatListRow(row: ChatListRow, now = Date.now()): string {
  // Favorite + rename need a real session file (the star is keyed by
  // sessionPath; piRpcInternal.renameSession writes into the file) — a
  // fresh never-saved draft only offers delete (which closes its tab).
  const canTarget = Boolean(row.sessionPath);
  const favTitle = row.favorite ? 'Remove from favorites' : 'Add to favorites';
  const detail = rowDetailText(row, now);
  // The action strip is a hover OVERLAY (absolute, own background), so the
  // name always gets the row's full width; the inline star badge (hidden
  // while hovering, when the toggle star is visible instead) is what marks
  // a favorite at rest. The full name rides on a custom tooltip shown
  // ABOVE the text (data-tooltip-pos) — names longer than the sidebar are
  // readable without widening it. role=option + tabindex=-1 make rows
  // keyboard-focusable targets for the listbox arrow-key navigation wired
  // in media/chatList.ts.
  return `<div class="chat-list-row${row.active ? ' active' : ''}${row.favorite ? ' favorite' : ''}" data-id="${esc(row.id)}" role="option" tabindex="-1" aria-selected="${row.active ? 'true' : 'false'}" aria-label="${esc(row.title)}">
    <span class="chat-list-row-icon">${row.active ? ICON_CHECK : ICON_CHAT}</span>
    <span class="chat-list-row-text" data-tooltip="${esc(row.title)}" data-tooltip-pos="above">
      <span class="chat-list-row-title">${row.favorite ? `<span class="chat-list-row-favbadge">${ICON_STAR_FILLED}</span>` : ''}${esc(row.title)}</span>
      ${detail || rowSizeWarning(row) ? `<span class="chat-list-row-detail">${detail ? esc(detail) : ''}${rowSizeWarning(row) ? `${detail ? ' · ' : ''}${rowSizeWarning(row)}` : ''}</span>` : ''}
    </span>
    <span class="chat-list-row-actions">
      <button class="chat-list-row-action" data-act="changes" data-tooltip="Git changes in chat folder" aria-label="Git changes in chat folder">${ICON_DIFF}</button>
      ${canTarget ? `<button class="chat-list-row-action chat-list-row-fav${row.favorite ? ' is-fav' : ''}" data-act="favorite" data-tooltip="${favTitle}" aria-label="${favTitle}">${row.favorite ? ICON_STAR_FILLED : ICON_STAR}</button>` : ''}
      ${canTarget ? `<button class="chat-list-row-action" data-act="rename" data-tooltip="Rename chat" aria-label="Rename chat">${ICON_PENCIL}</button>` : ''}
      <button class="chat-list-row-action chat-list-row-delete" data-act="delete" data-tooltip="Delete chat" aria-label="Delete chat">${ICON_TRASH}</button>
    </span>
  </div>`;
}

export interface ChatListBodyOptions {
  /** A search filter is active — an empty row set means "no matches", not
   * "no chats exist". */
  filterActive?: boolean;
  now?: number;
}

export function renderChatListBody(
  model: ChatListModel,
  options: ChatListBodyOptions = {}
): string {
  const now = options.now ?? Date.now();
  return model.loading
    ? `<div class="chat-list-loading">Loading chats…</div>`
    : model.error
      ? `<div class="chat-list-empty">${esc(model.error)}</div>`
      : model.rows.length === 0
        ? options.filterActive
          ? `<div class="chat-list-empty">No matching chats.</div>`
          : `<div class="chat-list-empty">No chats yet — start one above.</div>`
        : model.rows.map((row) => renderChatListRow(row, now)).join('');
}

export function renderChatListShell(bodyHtml: string, filterText = ''): string {
  return `
    <div class="chat-list-shell">
      <div class="chat-list-toolbar">
        <span class="chat-list-heading">Chats</span>
        <button class="sb-btn" id="switch-chat-btn" type="button" aria-label="Switch to full chat" data-tooltip="Switch to full chat">${ICON_SWITCH}</button>
        ${renderChatActionsMenu()}
        <button class="sb-btn chat-list-new-btn" id="new-chat-btn" type="button" aria-label="New chat" data-tooltip="New chat">${ICON_NEW_CHAT}</button>
      </div>
      <input class="chat-list-search" id="chat-list-search" type="text" placeholder="Search chats…" aria-label="Search chats" value="${esc(filterText)}" />
      <div class="chat-list-scroll" role="listbox" aria-label="Chats">${bodyHtml}</div>
    </div>
  `;
}
