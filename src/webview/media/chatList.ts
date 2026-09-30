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
  changes: (row) => vscode.postMessage({ type: 'showChatChanges', rowId: row.id }),
  favorite: toggleFavorite,
  rename: renameChat,
  delete: deleteChat,
};

let currentModel: ChatListModel = { rows: [], loading: true };
let filterText = '';
let filterDebounce: ReturnType<typeof setTimeout> | undefined;

function rowElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.chat-list-row'));
}

function focusRow(delta: number): void {
  const rowEls = rowElements();
  if (rowEls.length === 0) {
    return;
  }
  const current = rowEls.indexOf(document.activeElement as HTMLElement);
  const next =
    current === -1
      ? delta > 0
        ? 0
        : rowEls.length - 1
      : Math.max(0, Math.min(rowEls.length - 1, current + delta));
  rowEls[next]?.focus();
}

function render(): void {
  // innerHTML replacement nukes focus and the search input's caret —
  // capture and restore both so background snapshot pushes never eat a
  // keystroke mid-typing or drop keyboard-navigation focus.
  const activeId = (document.activeElement as HTMLElement | null)?.dataset?.id;
  const searchEl = document.getElementById('chat-list-search') as HTMLInputElement | null;
  const searchHadFocus = document.activeElement === searchEl;
  const caret = searchHadFocus ? (searchEl?.selectionStart ?? null) : null;
  // All markup comes from chatListRowHtml.ts (pure, golden-tested) — this
  // file only wires events onto it.
  app.innerHTML = renderChatListShell(
    renderChatListBody(currentModel, { filterActive: filterText.trim().length > 0 }),
    filterText
  );

  const search = document.getElementById('chat-list-search') as HTMLInputElement | null;
  search?.addEventListener('input', () => {
    filterText = search.value;
    if (filterDebounce) {
      clearTimeout(filterDebounce);
    }
    // Local repaint now (empty-state message + input value are webview
    // state); host round-trip debounced — it re-filters the full history,
    // not just the visible rows.
    filterDebounce = setTimeout(() => {
      vscode.postMessage({ type: 'filterChats', text: filterText });
    }, 150);
  });
  search?.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rowElements()[0]?.focus();
    } else if (event.key === 'Escape' && filterText) {
      event.stopPropagation();
      filterText = '';
      vscode.postMessage({ type: 'filterChats', text: '' });
      render();
      (document.getElementById('chat-list-search') as HTMLInputElement | null)?.focus();
    }
  });

  if (searchHadFocus && search) {
    search.focus();
    if (caret !== null) {
      search.setSelectionRange(caret, caret);
    }
  }

  for (const row of currentModel.rows) {
    const el = document.querySelector<HTMLElement>(`[data-id="${row.id.replace(/"/g, '\\"')}"]`);
    el?.addEventListener('click', () => openChat(row));
    el?.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openChat(row);
      }
    });
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

  if (activeId) {
    document.querySelector<HTMLElement>(`[data-id="${activeId.replace(/"/g, '\\"')}"]`)?.focus();
  }
}

// Arrow-key navigation over the whole list (delegated — survives re-renders).
document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.id === 'chat-list-search') {
    return; // the input has its own handler (ArrowDown hands off to rows)
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (target?.classList.contains('chat-list-row')) {
      event.preventDefault();
      focusRow(event.key === 'ArrowDown' ? 1 : -1);
    }
  } else if (event.key === 'Home' && target?.classList.contains('chat-list-row')) {
    event.preventDefault();
    rowElements()[0]?.focus();
  } else if (event.key === 'End' && target?.classList.contains('chat-list-row')) {
    event.preventDefault();
    rowElements().at(-1)?.focus();
  }
});

window.addEventListener('message', (event) => {
  const message = event.data as { type?: string; model?: ChatListModel };
  if (message?.type === 'listSnapshot' && message.model) {
    currentModel = message.model;
    render();
  }
});

// Keep "5m ago" fresh: relative time is formatted at paint time from
// row.modifiedAt, so a periodic repaint is all it takes — no host push.
setInterval(() => {
  if (!currentModel.loading && currentModel.rows.some((row) => row.modifiedAt)) {
    render();
  }
}, 60_000);

render();
vscode.postMessage({ type: 'requestListSnapshot' });
