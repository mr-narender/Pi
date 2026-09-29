// Pure string renderer for the Agentic Mode chat list — browser-safe, no
// vscode API, no DOM, no node imports. Split out of media/chatList.ts so the
// exact HTML the webview paints is golden-testable from node (the name-squeeze
// regression shipped precisely because this markup had zero coverage).
// media/chatList.ts owns wiring (postMessage, listeners) and MUST render
// through these functions only — new markup goes here, with a golden.
import type { ChatListModel, ChatListRow } from './chatListShared';

const ICON_PLUS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>';
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

export function renderChatListRow(row: ChatListRow): string {
  // Favorite + rename need a real session file (the star is keyed by
  // sessionPath; piRpcInternal.renameSession writes into the file) — a
  // fresh never-saved draft only offers delete (which closes its tab).
  const canTarget = Boolean(row.sessionPath);
  const favTitle = row.favorite ? 'Remove from favorites' : 'Add to favorites';
  // The action strip is a hover OVERLAY (absolute, own background), so the
  // name always gets the row's full width; the inline star badge (hidden
  // while hovering, when the toggle star is visible instead) is what marks
  // a favorite at rest. The full name rides on a [title] tooltip shown
  // ABOVE the text (data-tooltip-pos) — names longer than the sidebar are
  // readable without widening it.
  return `<div class="chat-list-row${row.active ? ' active' : ''}${row.favorite ? ' favorite' : ''}" data-id="${esc(row.id)}">
    <span class="chat-list-row-icon">${row.active ? ICON_CHECK : ICON_CHAT}</span>
    <span class="chat-list-row-text" title="${esc(row.title)}" data-tooltip-pos="above">
      <span class="chat-list-row-title">${row.favorite ? `<span class="chat-list-row-favbadge">${ICON_STAR_FILLED}</span>` : ''}${esc(row.title)}</span>
      ${row.detail ? `<span class="chat-list-row-detail">${esc(row.detail)}</span>` : ''}
    </span>
    <span class="chat-list-row-actions">
      ${canTarget ? `<button class="chat-list-row-action chat-list-row-fav${row.favorite ? ' is-fav' : ''}" data-act="favorite" title="${favTitle}" aria-label="${favTitle}">${row.favorite ? ICON_STAR_FILLED : ICON_STAR}</button>` : ''}
      ${canTarget ? `<button class="chat-list-row-action" data-act="rename" title="Rename chat" aria-label="Rename chat">${ICON_PENCIL}</button>` : ''}
      <button class="chat-list-row-action chat-list-row-delete" data-act="delete" title="Delete chat" aria-label="Delete chat">${ICON_TRASH}</button>
    </span>
  </div>`;
}

export function renderChatListBody(model: ChatListModel): string {
  return model.loading
    ? `<div class="chat-list-loading">Loading chats…</div>`
    : model.error
      ? `<div class="chat-list-empty">${esc(model.error)}</div>`
      : model.rows.length === 0
        ? `<div class="chat-list-empty">No chats yet — start one above.</div>`
        : model.rows.map(renderChatListRow).join('');
}

export function renderChatListShell(bodyHtml: string): string {
  // The Chat/Configure/System menu moved to the native toolbar (package.json
  // view/title → piRpc.chatListMore submenu), next to the mode-flip button —
  // no longer built here at all.
  return `
    <div class="chat-list-shell">
      <button class="chat-list-new-btn" id="new-chat-btn">${ICON_PLUS} New Chat</button>
      <div class="chat-list-scroll">${bodyHtml}</div>
    </div>
  `;
}
