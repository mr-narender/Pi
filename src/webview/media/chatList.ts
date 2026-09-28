import { buildDeleteMessage, type ChatListModel, type ChatListRow } from '../chatListShared';
import { installCustomTooltips } from './customTooltip';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
installCustomTooltips();

const ICON_PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5"/></svg>';
const ICON_CHAT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H8l-3.2 2.6a.5.5 0 0 1-.8-.4V11h-.5A1.5 1.5 0 0 1 2 9.5v-6Z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.5 8a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.5-8"/></svg>';
const STAR_PATH = 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3.1-3 4.3-.6L8 1.8z';
const ICON_STAR = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
const ICON_STAR_FILLED = `<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="${STAR_PATH}"/></svg>`;
const ICON_PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.1 2.4a1.4 1.4 0 0 1 2 2L5.6 11.9l-2.8.8.8-2.8 7.5-7.5z"/></svg>';

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function renderRow(row: ChatListRow): string {
  // Favorite + rename need a real session file (the star is keyed by
  // sessionPath; piRpcInternal.renameSession writes into the file) — a
  // fresh never-saved draft only offers delete (which closes its tab).
  const canTarget = Boolean(row.sessionPath);
  const favTitle = row.favorite ? 'Remove from favorites' : 'Add to favorites';
  return `<div class="chat-list-row${row.active ? ' active' : ''}${row.favorite ? ' favorite' : ''}" data-id="${esc(row.id)}">
    <span class="chat-list-row-icon">${row.active ? ICON_CHECK : ICON_CHAT}</span>
    <span class="chat-list-row-text">
      <span class="chat-list-row-title">${esc(row.title)}</span>
      ${row.detail ? `<span class="chat-list-row-detail">${esc(row.detail)}</span>` : ''}
    </span>
    <span class="chat-list-row-actions">
      ${canTarget ? `<button class="chat-list-row-action chat-list-row-fav${row.favorite ? ' is-fav' : ''}" data-act="favorite" title="${favTitle}" aria-label="${favTitle}">${row.favorite ? ICON_STAR_FILLED : ICON_STAR}</button>` : ''}
      ${canTarget ? `<button class="chat-list-row-action" data-act="rename" title="Rename chat" aria-label="Rename chat">${ICON_PENCIL}</button>` : ''}
      <button class="chat-list-row-action chat-list-row-delete" data-act="delete" title="Delete chat" aria-label="Delete chat">${ICON_TRASH}</button>
    </span>
  </div>`;
}

function openChat(row: ChatListRow): void {
  vscode.postMessage({
    type: 'openChat',
    isOpen: row.isOpen,
    resource: row.openCommand.resource,
    sessionPath: row.openCommand.sessionPath,
    label: row.openCommand.label ?? row.title,
  });
}

function deleteChat(row: ChatListRow): void {
  const message = buildDeleteMessage(row);
  if (message) {
    vscode.postMessage(message);
  }
}

function renameChat(row: ChatListRow): void {
  // Same requirement as piRpcInternal.renameSession itself: a real session
  // file to write the name into. A fresh draft that's never been saved
  // has nothing to rename yet — the menu item is hidden for that case
  // rather than offered and silently failing.
  if (row.sessionPath) {
    vscode.postMessage({ type: 'renameChat', sessionPath: row.sessionPath, label: row.title });
  }
}

function toggleFavorite(row: ChatListRow): void {
  // Same session-file requirement as rename: the star is keyed by path.
  if (row.sessionPath) {
    vscode.postMessage({ type: 'toggleFavoriteChat', sessionPath: row.sessionPath });
  }
}

// Per explicit feedback: hover icons ONLY, no right-click menu. The earlier
// custom context menu (Open/Rename/Delete) was removed — every action now
// lives in the hover-revealed .chat-list-row-actions strip.
const ROW_ACTIONS: Record<string, (row: ChatListRow) => void> = {
  favorite: toggleFavorite,
  rename: renameChat,
  delete: deleteChat,
};

let currentModel: ChatListModel = { rows: [], loading: true };

function render(): void {
  const body = currentModel.loading
    ? `<div class="chat-list-loading">Loading chats…</div>`
    : currentModel.error
      ? `<div class="chat-list-empty">${esc(currentModel.error)}</div>`
      : currentModel.rows.length === 0
        ? `<div class="chat-list-empty">No chats yet — start one above.</div>`
        : currentModel.rows.map(renderRow).join('');

  // The Chat/Configure/System menu moved to the native toolbar (package.json
  // view/title → piRpc.chatListMore submenu), next to the mode-flip button —
  // no longer built here at all.
  app.innerHTML = `
    <div class="chat-list-shell">
      <button class="chat-list-new-btn" id="new-chat-btn">${ICON_PLUS} New Chat</button>
      <div class="chat-list-scroll">${body}</div>
    </div>
  `;

  document.getElementById('new-chat-btn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'newChat' });
  });

  for (const row of currentModel.rows) {
    const el = document.querySelector(`[data-id="${row.id.replace(/"/g, '\\"')}"]`);
    el?.addEventListener('click', () => openChat(row));
    const actionButtons = el
      ? Array.from(el.querySelectorAll<HTMLElement>('.chat-list-row-action[data-act]'))
      : [];
    for (const button of actionButtons) {
      const action = ROW_ACTIONS[button.dataset.act ?? ''];
      if (action) {
        button.addEventListener('click', (event: Event) => {
          event.stopPropagation();
          action(row);
        });
      }
    }
  }
}

window.addEventListener('message', (event) => {
  const message = event.data as { type?: string; model?: ChatListModel };
  if (message?.type === 'listSnapshot' && message.model) {
    currentModel = message.model;
    render();
  }
});

render();
vscode.postMessage({ type: 'requestListSnapshot' });
