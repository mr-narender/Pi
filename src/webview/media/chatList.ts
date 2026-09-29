import { buildDeleteMessage, type ChatListModel, type ChatListRow } from '../chatListShared';
import { renderChatListBody, renderChatListShell } from '../chatListRowHtml';
import { installCustomTooltips } from './customTooltip';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
installCustomTooltips();

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
  // All markup comes from chatListRowHtml.ts (pure, golden-tested) — this
  // file only wires events onto it.
  app.innerHTML = renderChatListShell(renderChatListBody(currentModel));

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
