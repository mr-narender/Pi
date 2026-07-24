declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

import type { WebviewSnapshot } from '../../state/types';
import {
  COMPOSER_FIELD_ID,
  PREVIEW_DIALOG_ID,
  SEND_BUTTON_ID,
  focusTargetFromSnapshot,
  nextPreviewTrapTarget,
  planChipRemovalFocus,
  renderChatApp,
  renderRichText,
  shouldClearSnapshotFocus,
} from '../render';

const vscode = acquireVsCodeApi();
const root = document.getElementById('app');
let currentSnapshot: WebviewSnapshot | undefined;

// #6 — inline slash-command autocomplete state.
let slashCommands: Array<{ name: string; description: string }> | null = null;
let slashRequested = false;
let slashIndex = 0;
let slashMatches: Array<{ name: string; description: string }> = [];

function composerField(): HTMLTextAreaElement | null {
  return document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
}
function closeSlashMenu(): void {
  document.getElementById('slash-menu')?.remove();
  slashMatches = [];
  slashIndex = 0;
}
function acceptSlash(name: string): void {
  const field = composerField();
  if (!field) {
    return;
  }
  field.value = `/${name} `;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  closeSlashMenu();
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}
function paintSlashMenu(): void {
  const field = composerField();
  const dock = field?.closest('.composer-dock');
  if (!field || !dock) {
    return;
  }
  let menu = document.getElementById('slash-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'slash-menu';
    menu.className = 'slash-menu';
    menu.setAttribute('role', 'listbox');
    dock.appendChild(menu);
  }
  menu.replaceChildren();
  slashMatches.forEach((cmd, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `slash-item${index === slashIndex ? ' is-active' : ''}`;
    item.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'slash-name';
    name.textContent = `/${cmd.name}`;
    const desc = document.createElement('span');
    desc.className = 'slash-desc';
    desc.textContent = cmd.description;
    item.append(name, desc);
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      acceptSlash(cmd.name);
    });
    menu.appendChild(item);
  });
}
function updateSlashMenu(): void {
  const field = composerField();
  if (!field) {
    closeSlashMenu();
    return;
  }
  const match = /^\/([\w-]*)$/.exec(field.value);
  if (!match) {
    closeSlashMenu();
    return;
  }
  if (slashCommands === null) {
    if (!slashRequested) {
      slashRequested = true;
      vscode.postMessage({ type: 'requestSlashCommands' });
    }
    return;
  }
  const query = (match[1] ?? '').toLowerCase();
  const next = slashCommands.filter((cmd) => cmd.name.toLowerCase().startsWith(query)).slice(0, 8);
  if (next.length === 0) {
    closeSlashMenu();
    return;
  }
  if (slashIndex >= next.length) {
    slashIndex = 0;
  }
  slashMatches = next;
  paintSlashMenu();
}
function handleSlashKeydown(event: KeyboardEvent): boolean {
  if (slashMatches.length === 0) {
    return false;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    slashIndex = (slashIndex + 1) % slashMatches.length;
    paintSlashMenu();
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
    paintSlashMenu();
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    acceptSlash(slashMatches[slashIndex]?.name ?? '');
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSlashMenu();
    return true;
  }
  return false;
}

// #9 — @file mention autocomplete state.
let mentionItems: Array<{ path: string; name: string }> = [];
let mentionIndex = 0;
let mentionActive = false;
// null (not '') so that the very first bare "@" (empty query) still triggers a
// request — otherwise '' === '' skips it and no file list ever loads.
let mentionQuery: string | null = null;
function mentionContext(field: HTMLTextAreaElement): { start: number; query: string } | null {
  const caret = field.selectionStart ?? field.value.length;
  const before = field.value.slice(0, caret);
  const match = /(^|\s)@([\w./-]*)$/.exec(before);
  if (!match) {
    return null;
  }
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}
function closeMentionMenu(): void {
  document.getElementById('mention-menu')?.remove();
  mentionItems = [];
  mentionIndex = 0;
  mentionActive = false;
  mentionQuery = null;
}
function acceptMention(path: string): void {
  const field = composerField();
  if (!field) {
    return;
  }
  const ctx = mentionContext(field);
  if (ctx) {
    const caret = field.selectionStart ?? field.value.length;
    field.value = field.value.slice(0, ctx.start) + field.value.slice(caret);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    field.setSelectionRange(ctx.start, ctx.start);
  }
  vscode.postMessage({ type: 'attachFile', path });
  closeMentionMenu();
}
function paintMentionMenu(): void {
  const field = composerField();
  const dock = field?.closest('.composer-dock');
  if (!field || !dock) {
    return;
  }
  let menu = document.getElementById('mention-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'mention-menu';
    menu.className = 'slash-menu';
    menu.setAttribute('role', 'listbox');
    dock.appendChild(menu);
  }
  menu.replaceChildren();
  mentionItems.forEach((entry, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `slash-item${index === mentionIndex ? ' is-active' : ''}`;
    item.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'slash-name';
    name.textContent = entry.name;
    const desc = document.createElement('span');
    desc.className = 'slash-desc';
    desc.textContent = entry.path;
    item.append(name, desc);
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      acceptMention(entry.path);
    });
    menu.appendChild(item);
  });
}
function updateMentionMenu(): void {
  const field = composerField();
  if (!field) {
    closeMentionMenu();
    return;
  }
  const ctx = mentionContext(field);
  if (!ctx) {
    if (mentionActive) {
      closeMentionMenu();
    }
    return;
  }
  mentionActive = true;
  if (ctx.query !== mentionQuery) {
    mentionQuery = ctx.query;
    vscode.postMessage({ type: 'requestFileMentions', query: ctx.query });
  }
  if (mentionItems.length > 0) {
    paintMentionMenu();
  }
}
function handleMentionKeydown(event: KeyboardEvent): boolean {
  if (!mentionActive || mentionItems.length === 0) {
    return false;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    mentionIndex = (mentionIndex + 1) % mentionItems.length;
    paintMentionMenu();
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    mentionIndex = (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
    paintMentionMenu();
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    acceptMention(mentionItems[mentionIndex]?.path ?? '');
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMentionMenu();
    return true;
  }
  return false;
}
let pendingFocusTargetId: string | undefined;
let pendingFocusFallbackId: string | undefined;
let previewReturnFocusId: string | undefined;
let lastComposerResetSeq: number | undefined;
// Message-windowing scroll state.
let lastMessageKey: string | undefined;
let lastWindowOffset: number | undefined;
let loadOlderPending = false;
// When a chat is opened/switched, we must land at the bottom. The first render
// for a resource is often the empty "loading" state (no messages yet), so we
// remember the intent and perform the scroll on the render where messages
// actually appear.
let pendingBottomKey: string | undefined;

// Robust scroll-to-bottom. With the virtualized list, off-screen messages use
// `content-visibility` with an *estimated* height, so `scrollHeight` keeps
// changing as messages render into view or images/code lay out. Instead of a
// one-shot assignment, we PIN to the bottom across a short window, re-asserting
// every animation frame so late relayout can't leave us stranded near the top.
// The user scrolling (wheel/touch/keys) cancels the pin immediately.
let bottomPinUntil = 0;
let bottomPinRaf = 0;
function scrollMessagesToBottom(messages: HTMLElement, durationMs = 650): void {
  messages.scrollTop = messages.scrollHeight;
  bottomPinUntil = performance.now() + durationMs;
  if (bottomPinRaf) {
    return;
  }
  const step = (): void => {
    const el = document.getElementById('messages');
    if (el && performance.now() < bottomPinUntil) {
      el.scrollTop = el.scrollHeight;
      bottomPinRaf = requestAnimationFrame(step);
    } else {
      bottomPinRaf = 0;
      (el?.lastElementChild as HTMLElement | null)?.scrollIntoView({ block: 'end' });
    }
  };
  bottomPinRaf = requestAnimationFrame(step);
}
// Any explicit user scroll intent cancels an active bottom-pin.
for (const evt of ['wheel', 'touchmove', 'keydown'] as const) {
  window.addEventListener(
    evt,
    (event) => {
      if (evt === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (key !== 'PageUp' && key !== 'ArrowUp' && key !== 'Home') {
          return;
        }
      }
      bottomPinUntil = 0;
    },
    { passive: true }
  );
}
let olderObserver: IntersectionObserver | undefined;

function queueFocus(targetId?: string, fallbackId = COMPOSER_FIELD_ID): void {
  pendingFocusTargetId = targetId;
  pendingFocusFallbackId = fallbackId;
}

function submitComposer(command: string): void {
  previewReturnFocusId = SEND_BUTTON_ID;
  // Optimistically clear the input immediately on submit (native chat feel),
  // unless there are pending attachments — those open a preview instead of
  // sending. If the send fails, the extension restores the draft via recovery.
  const hasPending =
    !!currentSnapshot &&
    (currentSnapshot.pendingContextItems.length > 0 || currentSnapshot.pendingImages.length > 0);
  if (!hasPending) {
    const textarea = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.value = '';
    }
  }
  vscode.postMessage({ type: 'requestSend', command });
}

function focusElement(id: string | undefined): boolean {
  if (!id) {
    return false;
  }
  const element = document.getElementById(id) as HTMLElement | null;
  element?.focus?.();
  return document.activeElement === element && element !== null;
}

function queuePreviewReturnFocus(): void {
  queueFocus(previewReturnFocusId, COMPOSER_FIELD_ID);
  previewReturnFocusId = undefined;
}

function handlePreviewKeydown(event: KeyboardEvent): void {
  if (!currentSnapshot?.preview) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    queuePreviewReturnFocus();
    vscode.postMessage({ type: 'cancelPreview' });
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  event.preventDefault();
  focusElement(
    nextPreviewTrapTarget((document.activeElement as HTMLElement | null)?.id, event.shiftKey)
  );
}

function persistViewState(): void {
  const messages = document.getElementById('messages');
  vscode.setState({
    scrollTop: messages?.scrollTop ?? 0,
    activeElementId: (document.activeElement as HTMLElement | null)?.id,
  });
}

interface ScrollMetrics {
  prevScrollHeight: number;
  prevScrollTop: number;
  wasNearBottom: boolean;
}

// Screen-reader announcements: concise milestones only (not per-token), routed
// through a dedicated aria-live region so streaming doesn't flood the reader.
let lastBusyAnnounced = false;
function announce(text: string): void {
  const el = document.getElementById('a11y-status');
  if (!el || !text) {
    return;
  }
  el.textContent = '';
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}
function announceTurnState(snapshot: WebviewSnapshot): void {
  const busy = snapshot.connectionState === 'busy' || snapshot.isStreaming === true;
  if (busy && !lastBusyAnnounced) {
    announce('Pi is working\u2026');
  } else if (!busy && lastBusyAnnounced) {
    const lastAssistant = [...snapshot.messages].reverse().find((m) => m.role === 'assistant');
    const text = (lastAssistant?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
    announce(text ? `Pi responded. ${text}` : 'Pi finished responding.');
  }
  lastBusyAnnounced = busy;
}
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function render(snapshot: WebviewSnapshot): void {
  currentSnapshot = snapshot;
  if (!root) {
    return;
  }
  announceTurnState(snapshot);

  // Capture pre-render scroll metrics so we can decide, after the DOM is
  // rebuilt, whether to jump to the bottom (open/stream) or anchor the
  // viewport (older messages prepended on scroll-up).
  const prevMessages = document.getElementById('messages');
  const prevScrollHeight = prevMessages?.scrollHeight ?? 0;
  const prevScrollTop = prevMessages?.scrollTop ?? 0;
  const prevClientHeight = prevMessages?.clientHeight ?? 0;
  const scrollMetrics: ScrollMetrics = {
    prevScrollHeight,
    prevScrollTop,
    wasNearBottom: !prevMessages || prevScrollHeight - prevScrollTop - prevClientHeight < 96,
  };

  // Preserve the user's in-progress composer text, caret, and focus across a
  // full re-render. Without this, any snapshot that arrives while the user is
  // typing (draft echo, streaming tokens, status updates) rebuilds the DOM and
  // resets the caret to position 0.
  const previousComposer = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  const composerWasFocused = !!previousComposer && document.activeElement === previousComposer;
  const preservedValue = composerWasFocused ? previousComposer.value : undefined;
  const preservedStart = composerWasFocused ? previousComposer.selectionStart : undefined;
  const preservedEnd = composerWasFocused ? previousComposer.selectionEnd : undefined;

  // An authoritative composer reset (send-clear, copy-to-composer, restore)
  // must overwrite the field even if it was focused.
  const resetSeq = snapshot.composerResetSeq;
  const authoritativeReset = resetSeq !== undefined && resetSeq !== lastComposerResetSeq;
  lastComposerResetSeq = resetSeq;

  // Preserve open dropdown menus across re-render so passive snapshots
  // (streaming, status) don't close the More/Attach menu mid-interaction.
  const openMenus = new Set<string>();
  for (const id of ['more-menu', 'attach-menu']) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (el?.open) {
      openMenus.add(id);
    }
  }

  root.innerHTML = renderChatApp(snapshot);

  for (const id of openMenus) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (el) {
      el.open = true;
    }
  }

  const textarea = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  if (textarea && composerWasFocused && !authoritativeReset && document.hasFocus()) {
    if (typeof preservedValue === 'string') {
      textarea.value = preservedValue;
    }
    textarea.focus();
    const caret = preservedStart ?? textarea.value.length;
    const caretEnd = preservedEnd ?? caret;
    try {
      textarea.setSelectionRange(caret, caretEnd);
    } catch {
      /* setSelectionRange can throw for some input types; ignore */
    }
  } else if (textarea && composerWasFocused && authoritativeReset && document.hasFocus()) {
    textarea.focus();
    const end = textarea.value.length;
    try {
      textarea.setSelectionRange(end, end);
    } catch {
      /* ignore */
    }
  }
  textarea?.addEventListener('input', () => {
    vscode.postMessage({ type: 'setDraft', text: textarea.value });
  });
  textarea?.addEventListener('focus', () => {
    vscode.postMessage({ type: 'setFocus', focus: 'composer' });
  });
  textarea?.addEventListener('input', () => {
    updateSlashMenu();
    updateMentionMenu();
  });
  textarea?.addEventListener('keyup', (event) => {
    // Arrow/click caret moves can enter/leave an @ context without an input event.
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
      updateMentionMenu();
    }
  });
  // Image paste: pasting a screenshot/image into the composer attaches it.
  textarea?.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const entry of Array.from(items)) {
      if (entry.kind === 'file' && entry.type.startsWith('image/')) {
        const file = entry.getAsFile();
        if (!file) {
          continue;
        }
        event.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const comma = result.indexOf(',');
          const data = comma >= 0 ? result.slice(comma + 1) : '';
          if (data) {
            vscode.postMessage({ type: 'pasteImage', data, mimeType: file.type });
          }
        };
        reader.readAsDataURL(file);
      }
    }
  });
  // #9 — drag a file from the Explorer onto the composer to attach it.
  textarea?.addEventListener('dragover', (event) => {
    event.preventDefault();
    textarea.classList.add('drop-target');
  });
  textarea?.addEventListener('dragleave', () => textarea.classList.remove('drop-target'));
  textarea?.addEventListener('drop', (event) => {
    textarea.classList.remove('drop-target');
    const data =
      event.dataTransfer?.getData('text/uri-list') ||
      event.dataTransfer?.getData('resourceurls') ||
      '';
    if (!data) {
      return;
    }
    event.preventDefault();
    let uris: string[] = [];
    try {
      const parsed = JSON.parse(data) as unknown;
      uris = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      uris = data.split(/\r?\n/);
    }
    for (const uri of uris
      .map((value) => value.trim())
      .filter((value) => value && value[0] !== '#')) {
      vscode.postMessage({ type: 'attachFile', path: uri });
    }
  });
  textarea?.addEventListener('keydown', (event) => {
    // #6/#9 — slash and mention menu navigation take priority when open.
    if (handleSlashKeydown(event) || handleMentionKeydown(event)) {
      return;
    }
    // Enter submits (TUI-style); Shift+Enter inserts a newline. Cmd/Ctrl+Enter
    // also submits. IME composition Enter is ignored so it doesn't send mid-word.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const sendButton = document.getElementById(SEND_BUTTON_ID) as HTMLButtonElement | null;
      if (!sendButton || sendButton.disabled) {
        return;
      }
      submitComposer(sendButton.dataset.sendCommand ?? 'prompt');
    }
  });

  document.getElementById('folder-select')?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    vscode.postMessage({ type: 'switchFolder', folderUri: target.value });
  });

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-send-command]')
  )) {
    button.addEventListener('click', () => {
      previewReturnFocusId = button.id || SEND_BUTTON_ID;
      submitComposer(button.dataset.sendCommand ?? 'prompt');
    });
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-action]')
  )) {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (!action) {
        return;
      }
      if (action === 'acceptPreview') {
        previewReturnFocusId = undefined;
        vscode.postMessage({ type: 'acceptPreview' });
        return;
      }
      if (action === 'cancelPreview') {
        queuePreviewReturnFocus();
        vscode.postMessage({ type: 'cancelPreview' });
        return;
      }
      if (action === 'copyAcceptedSnapshot') {
        vscode.postMessage({ type: 'copyAcceptedSnapshot' });
        return;
      }
      if (action === 'sendAcceptedSnapshotAgain') {
        vscode.postMessage({ type: 'sendAcceptedSnapshotAgain' });
        return;
      }
      if (action === 'abort') {
        vscode.postMessage({ type: 'abort' });
        return;
      }
      vscode.postMessage({ type: action });
    });
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-command]')
  )) {
    button.addEventListener('click', () => {
      // Close the containing dropdown menu (if any) so it doesn't linger.
      button.closest('details')?.removeAttribute('open');
      vscode.postMessage({ type: 'executeCommand', command: button.dataset.command });
    });
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-remove-context]')
  )) {
    button.addEventListener('click', () => {
      if (!currentSnapshot || !button.dataset.removeContext) {
        return;
      }
      const plan = planChipRemovalFocus(currentSnapshot, button.dataset.removeContext);
      queueFocus(plan.targetId, plan.fallbackId);
      vscode.postMessage({ type: 'removeContextItem', itemId: button.dataset.removeContext });
    });
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-remove-image]')
  )) {
    button.addEventListener('click', () => {
      if (!currentSnapshot || !button.dataset.removeImage) {
        return;
      }
      const plan = planChipRemovalFocus(currentSnapshot, button.dataset.removeImage);
      queueFocus(plan.targetId, plan.fallbackId);
      vscode.postMessage({ type: 'removeImageItem', itemId: button.dataset.removeImage });
    });
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-attachment-uri]')
  )) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'openAttachment', uri: button.dataset.attachmentUri });
    });
  }

  const codeTextAndLang = (button: HTMLButtonElement): { text: string; language: string } => {
    const wrap = button.closest('.code-wrap');
    return {
      text: wrap?.querySelector('.code-block code')?.textContent ?? '',
      language: wrap?.getAttribute('data-lang') ?? '',
    };
  };
  // Tool approval: Allow/Deny (or option) buttons respond to the pending request.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.approval-btn'))) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-ui-id');
      if (!id) {
        return;
      }
      const confirmed = button.getAttribute('data-ui-confirmed');
      const value = button.getAttribute('data-ui-value');
      const message: { type: 'respondUi'; id: string; value?: string; confirmed?: boolean } = {
        type: 'respondUi',
        id,
      };
      if (confirmed !== null) {
        message.confirmed = confirmed === 'true';
      } else if (value !== null) {
        message.value = value;
      }
      vscode.postMessage(message);
    });
  }

  // Onboarding: clicking an example prompt loads it into the composer.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-example]'))) {
    button.addEventListener('click', () => {
      const text = button.getAttribute('data-example') ?? '';
      const field = composerField();
      if (field && text) {
        field.value = text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    });
  }

  // #3 — open file / open changes for edit-tool cards.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-open]'))) {
    button.addEventListener('click', () => {
      const path = button.getAttribute('data-file-open');
      if (path) {
        vscode.postMessage({ type: 'openFile', path });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-diff]'))) {
    button.addEventListener('click', () => {
      const path = button.getAttribute('data-file-diff');
      if (path) {
        vscode.postMessage({ type: 'openDiff', path });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-insert'))) {
    button.addEventListener('click', () => {
      const { text, language } = codeTextAndLang(button);
      if (text) {
        vscode.postMessage({ type: 'insertCode', text, language });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-newfile'))) {
    button.addEventListener('click', () => {
      const { text, language } = codeTextAndLang(button);
      if (text) {
        vscode.postMessage({ type: 'newFileFromCode', text, language });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-copy'))) {
    button.addEventListener('click', () => {
      const code = button.closest('.code-wrap')?.querySelector('.code-block code');
      const text = code?.textContent ?? '';
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          const previous = button.textContent;
          button.textContent = 'Copied';
          button.classList.add('is-copied');
          setTimeout(() => {
            button.textContent = previous ?? 'Copy';
            button.classList.remove('is-copied');
          }, 1200);
        })
        .catch(() => undefined);
    });
  }

  document.getElementById(PREVIEW_DIALOG_ID)?.addEventListener('keydown', handlePreviewKeydown);

  // #1 — Markdown links open externally (no in-webview navigation).
  for (const link of Array.from(root.querySelectorAll<HTMLElement>('.md-link'))) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const url = link.getAttribute('data-href');
      if (url) {
        vscode.postMessage({ type: 'openExternal', url });
      }
    });
  }

  // #4 — edit a message back into the composer (client-side, updates the draft).
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.msg-edit'))) {
    button.addEventListener('click', () => {
      const article = button.closest('.message-card');
      const text = article?.querySelector('.message-body')?.textContent?.trim() ?? '';
      const textarea = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
      if (textarea && text) {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        try {
          textarea.setSelectionRange(text.length, text.length);
        } catch {
          /* ignore */
        }
      }
    });
  }

  // #3 — copy a single message's output.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.msg-copy'))) {
    button.addEventListener('click', () => {
      const article = button.closest('.message-card');
      const text =
        article?.querySelector('.tl-answer .tl-body')?.textContent ??
        article?.querySelector('.message-body')?.textContent ??
        article?.querySelector('.tl-body')?.textContent ??
        '';
      if (!text.trim()) {
        return;
      }
      void navigator.clipboard
        ?.writeText(text.trim())
        .then(() => {
          button.classList.add('is-copied');
          setTimeout(() => button.classList.remove('is-copied'), 1000);
        })
        .catch(() => undefined);
    });
  }

  // #7 — clamp toggle for long tool/result output.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-showmore'))) {
    button.addEventListener('click', () => {
      const wrap = button.closest('.clampable');
      const expanded = wrap?.classList.toggle('expanded') ?? false;
      button.textContent = expanded ? 'Show less' : 'Show more';
    });
  }

  const messagesEl = document.getElementById('messages');
  messagesEl?.addEventListener('scroll', persistViewState, { passive: true });

  // #6 — jump-to-latest button appears when scrolled up.
  const jumpBtn = document.getElementById('jump-latest') as HTMLButtonElement | null;
  if (messagesEl && jumpBtn) {
    const updateJump = (): void => {
      const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      jumpBtn.hidden = distance < 120;
    };
    messagesEl.addEventListener('scroll', updateJump, { passive: true });
    jumpBtn.addEventListener('click', () => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      jumpBtn.hidden = true;
    });
    updateJump();
  }

  advanceTypewriter();
  startWorkingAnimation();
  applyScrollAndPaging(snapshot, scrollMetrics);
  applyFocus();
  if (findOpen) {
    runFind(findQuery, false);
  }
}

// In-chat find (Cmd/Ctrl+F): highlight + step through matches, scoped to this
// chat. Uses the CSS Custom Highlight API (no DOM mutation), so highlights
// recompute cleanly after every streaming re-render.
let findOpen = false;
let findQuery = '';
let findRanges: Range[] = [];
let findIndex = 0;
interface HighlightCtor {
  new (...ranges: Range[]): unknown;
}
function highlightsApi(): {
  set(name: string, h: unknown): void;
  delete(name: string): void;
} | null {
  const api = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  return api
    ? (api as unknown as { set(n: string, h: unknown): void; delete(n: string): void })
    : null;
}
function clearFindHighlights(): void {
  const api = highlightsApi();
  api?.delete('pi-find');
  api?.delete('pi-find-current');
}
function buildFindBar(): HTMLElement {
  let bar = document.getElementById('pi-find-bar');
  if (bar) {
    return bar;
  }
  bar = document.createElement('div');
  bar.id = 'pi-find-bar';
  bar.className = 'find-bar';
  bar.hidden = true;
  bar.innerHTML =
    '<input id="pi-find-input" class="find-input" type="text" placeholder="Find in chat" aria-label="Find in chat" />' +
    '<span id="pi-find-count" class="find-count"></span>' +
    '<button id="pi-find-prev" class="find-btn" title="Previous (Shift+Enter)" aria-label="Previous match">\u2191</button>' +
    '<button id="pi-find-next" class="find-btn" title="Next (Enter)" aria-label="Next match">\u2193</button>' +
    '<button id="pi-find-close" class="find-btn" title="Close (Esc)" aria-label="Close find">\u2715</button>';
  document.body.appendChild(bar);
  const input = bar.querySelector<HTMLInputElement>('#pi-find-input');
  input?.addEventListener('input', () => runFind(input.value, true));
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      stepFind(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });
  bar.querySelector('#pi-find-prev')?.addEventListener('click', () => stepFind(-1));
  bar.querySelector('#pi-find-next')?.addEventListener('click', () => stepFind(1));
  bar.querySelector('#pi-find-close')?.addEventListener('click', () => closeFind());
  return bar;
}
function openFind(): void {
  const bar = buildFindBar();
  bar.hidden = false;
  findOpen = true;
  const input = document.getElementById('pi-find-input') as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
  }
}
function closeFind(): void {
  findOpen = false;
  findQuery = '';
  findRanges = [];
  clearFindHighlights();
  const bar = document.getElementById('pi-find-bar');
  if (bar) {
    bar.hidden = true;
  }
  composerField()?.focus();
}
function collectRanges(query: string): Range[] {
  const container = document.getElementById('messages');
  if (!container || !query) {
    return [];
  }
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && ranges.length < 1000) {
    const text = node.nodeValue ?? '';
    const hay = text.toLowerCase();
    let from = 0;
    let at = hay.indexOf(needle, from);
    while (at >= 0) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      from = at + needle.length;
      at = hay.indexOf(needle, from);
    }
    node = walker.nextNode();
  }
  return ranges;
}
function runFind(query: string, resetIndex: boolean): void {
  findQuery = query;
  clearFindHighlights();
  findRanges = collectRanges(query);
  if (resetIndex || findIndex >= findRanges.length) {
    findIndex = 0;
  }
  const api = highlightsApi();
  const HighlightImpl = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
  if (api && HighlightImpl && findRanges.length > 0) {
    api.set('pi-find', new HighlightImpl(...findRanges));
  }
  updateFindCurrent(false);
}
function updateFindCurrent(scroll: boolean): void {
  const count = document.getElementById('pi-find-count');
  if (count) {
    count.textContent =
      findRanges.length > 0 ? `${findIndex + 1}/${findRanges.length}` : 'No results';
  }
  const api = highlightsApi();
  const HighlightImpl = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
  const current = findRanges[findIndex];
  if (api && HighlightImpl && current) {
    api.set('pi-find-current', new HighlightImpl(current));
  }
  if (scroll && current) {
    (current.startContainer.parentElement ?? null)?.scrollIntoView({ block: 'center' });
  }
}
function stepFind(direction: number): void {
  if (findRanges.length === 0) {
    return;
  }
  findIndex = (findIndex + direction + findRanges.length) % findRanges.length;
  updateFindCurrent(true);
}
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openFind();
  }
});

// Typewriter smoothing: Pi streams the answer as coarse `message_update`
// snapshots (~every 400ms), not token deltas. We reveal the newly-arrived
// characters gradually so it reads like the TUI's smooth typing. The streaming
// answer element is marked `.js-stream-text` with the full text in `data-raw`.
let streamTimer: ReturnType<typeof setInterval> | undefined;
let streamRaw = '';
let streamRevealLen = 0;
function stopTypewriter(): void {
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = undefined;
  }
}
function streamTarget(): HTMLElement | undefined {
  const nodes = document.querySelectorAll<HTMLElement>('#messages .js-stream-text');
  return nodes.length > 0 ? nodes[nodes.length - 1] : undefined;
}
function keepPinnedToBottom(): void {
  const messages = document.getElementById('messages');
  if (messages && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120) {
    messages.scrollTop = messages.scrollHeight;
  }
}
const TYPEWRITER_SPEEDS: Record<string, { divisor: number; interval: number }> = {
  slow: { divisor: 12, interval: 34 },
  normal: { divisor: 8, interval: 28 },
  fast: { divisor: 5, interval: 18 },
};
function advanceTypewriter(): void {
  const busy = currentSnapshot?.connectionState === 'busy';
  const speed = currentSnapshot?.typewriterSpeed ?? 'normal';
  const el = busy ? streamTarget() : undefined;
  if (!el || speed === 'off' || prefersReducedMotion()) {
    // Off, stream ended, or no live answer: the render already shows the full
    // text. Reset for the next turn.
    stopTypewriter();
    streamRaw = '';
    streamRevealLen = 0;
    return;
  }
  const raw = el.getAttribute('data-raw') ?? '';
  // New message or a shrink -> restart the reveal from zero.
  if (raw.length < streamRevealLen || (streamRaw && !raw.startsWith(streamRaw.slice(0, 12)))) {
    streamRevealLen = 0;
  }
  streamRaw = raw;
  // Sync the DOM to the currently-revealed prefix in the SAME frame as the
  // render() innerHTML swap, so there is no flash of the full text.
  el.innerHTML = renderRichText(raw.slice(0, streamRevealLen));
  const tuning = TYPEWRITER_SPEEDS[speed] ?? { divisor: 8, interval: 28 };
  if (!streamTimer) {
    streamTimer = setInterval(() => {
      const node = streamTarget();
      if (!node || currentSnapshot?.connectionState !== 'busy') {
        stopTypewriter();
        return;
      }
      const target = streamRaw.length;
      if (streamRevealLen >= target) {
        return; // caught up; wait for the next update to grow the target
      }
      const step = Math.max(2, Math.ceil((target - streamRevealLen) / tuning.divisor));
      streamRevealLen = Math.min(target, streamRevealLen + step);
      node.innerHTML = renderRichText(streamRaw.slice(0, streamRevealLen));
      keepPinnedToBottom();
    }, tuning.interval);
  }
}

const WORKING_FRAMES: Record<string, string[]> = {
  braille: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  earth: ['🌍', '🌎', '🌏'],
  moon: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
};
// A single persistent interval drives the working animation. It re-targets the
// current .working-glyph each tick, so frequent re-renders during streaming
// don't reset/freeze it. The frame index persists across re-renders.
let workingTimer: ReturnType<typeof setInterval> | undefined;
let workingFrame = 0;
function stopWorkingAnimation(): void {
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = undefined;
  }
}
function startWorkingAnimation(): void {
  const container = document.querySelector('.working');
  if (!container) {
    stopWorkingAnimation();
    return;
  }
  const anim = container.getAttribute('data-anim') ?? 'braille';
  if (anim === 'dolphin') {
    const glyph = container.querySelector('.working-glyph');
    if (glyph) {
      glyph.textContent = '🐬';
    }
    stopWorkingAnimation();
    return;
  }
  const frames = WORKING_FRAMES[anim];
  if (!frames) {
    stopWorkingAnimation(); // dots / bars are pure CSS
    return;
  }
  const paint = (): void => {
    const glyph = document.querySelector('.working .working-glyph');
    if (glyph) {
      glyph.textContent = frames[workingFrame % frames.length] ?? '';
    }
  };
  paint();
  if (!workingTimer) {
    workingTimer = setInterval(() => {
      workingFrame = (workingFrame + 1) % 1_000_000;
      paint();
    }, 110);
  }
}

function applyScrollAndPaging(snapshot: WebviewSnapshot, metrics: ScrollMetrics): void {
  const messages = document.getElementById('messages');
  if (!messages) {
    return;
  }
  const win = snapshot.messageWindow;
  const key = snapshot.sessionFile ?? snapshot.sessionId ?? 'draft';
  const isNewResource = key !== lastMessageKey;
  const olderLoaded =
    !isNewResource &&
    win !== undefined &&
    lastWindowOffset !== undefined &&
    win.offset < lastWindowOffset;

  const hasMessages = snapshot.messages.length > 0;

  if (isNewResource) {
    // Opening/switching a chat: land at the last message. If messages have not
    // arrived yet (loading state), defer the jump to the render that has them.
    lastMessageKey = key;
    lastWindowOffset = win?.offset;
    if (hasMessages) {
      scrollMessagesToBottom(messages);
    } else {
      pendingBottomKey = key;
    }
    setupOlderObserver(messages, win);
    persistViewState();
    return;
  }

  if (pendingBottomKey === key && hasMessages) {
    // Messages finally rendered for a freshly-opened chat: now jump to bottom.
    pendingBottomKey = undefined;
    scrollMessagesToBottom(messages);
  } else if (olderLoaded) {
    // Older batch was prepended: keep the viewport anchored on the message the
    // user was looking at (no jump).
    const delta = messages.scrollHeight - metrics.prevScrollHeight;
    messages.scrollTop = metrics.prevScrollTop + delta;
    loadOlderPending = false;
  } else if (metrics.wasNearBottom) {
    // Live streaming while already near the bottom: stick to the bottom.
    scrollMessagesToBottom(messages);
  } else {
    messages.scrollTop = metrics.prevScrollTop;
  }

  lastMessageKey = key;
  lastWindowOffset = win?.offset;
  setupOlderObserver(messages, win);
  persistViewState();
}

function setupOlderObserver(container: HTMLElement, win: WebviewSnapshot['messageWindow']): void {
  olderObserver?.disconnect();
  olderObserver = undefined;
  const sentinel = document.getElementById('older-sentinel');
  if (!sentinel || !win?.hasOlder) {
    return;
  }
  olderObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !loadOlderPending) {
          loadOlderPending = true;
          vscode.postMessage({ type: 'loadOlder' });
        }
      }
    },
    { root: container, rootMargin: '250px 0px 0px 0px', threshold: 0 }
  );
  olderObserver.observe(sentinel);
}

function applyFocus(): void {
  if (!root || !currentSnapshot) {
    return;
  }
  // Never grab focus while a native picker/dialog (QuickPick, InputBox) is open.
  // The webview loses document focus then; focusing our composer would steal it
  // back and instantly dismiss the picker (a flicker).
  if (!document.hasFocus()) {
    return;
  }
  const pendingTargetId = pendingFocusTargetId;
  const pendingFallbackId = pendingFocusFallbackId;
  pendingFocusTargetId = undefined;
  pendingFocusFallbackId = undefined;
  if (focusElement(pendingTargetId) || focusElement(pendingFallbackId)) {
    return;
  }
  const targetId = focusTargetFromSnapshot(currentSnapshot);
  if (focusElement(targetId)) {
    if (shouldClearSnapshotFocus(currentSnapshot.focus)) {
      vscode.postMessage({ type: 'setFocus', focus: 'none' });
    }
    return;
  }
  if (focusElement(PREVIEW_DIALOG_ID)) {
    return;
  }
  focusElement(COMPOSER_FIELD_ID);
}

window.addEventListener('beforeunload', persistViewState);

// #8 — Cmd/Ctrl+K opens the Pi command palette (quick actions).
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    vscode.postMessage({ type: 'executeCommand', command: 'piRpc.commandPalette' });
  }
});

// #4 — double-Escape stops the current generation.
let lastEscapeAt = 0;
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  const now = Date.now();
  if (now - lastEscapeAt < 600) {
    lastEscapeAt = 0;
    const busy =
      currentSnapshot?.connectionState === 'busy' || currentSnapshot?.isStreaming === true;
    if (busy) {
      vscode.postMessage({ type: 'executeCommand', command: 'piRpc.abort' });
    }
  } else {
    lastEscapeAt = now;
  }
});

window.addEventListener(
  'message',
  (event: MessageEvent<{ type: string; snapshot: WebviewSnapshot }>) => {
    if (event.data?.type === 'snapshot') {
      render(event.data.snapshot);
      // Re-evaluate the menus after a re-render (composer text is preserved).
      updateSlashMenu();
      updateMentionMenu();
    } else if (event.data?.type === 'fileMentions') {
      const payload = event.data as unknown as {
        items?: Array<{ path: string; name: string }>;
      };
      mentionItems = Array.isArray(payload.items) ? payload.items : [];
      mentionIndex = 0;
      if (mentionActive && mentionItems.length > 0) {
        paintMentionMenu();
      } else if (mentionItems.length === 0) {
        document.getElementById('mention-menu')?.remove();
      }
    } else if (event.data?.type === 'slashCommands') {
      const payload = event.data as unknown as {
        items?: Array<{ name: string; description: string }>;
      };
      slashCommands = Array.isArray(payload.items) ? payload.items : [];
      updateSlashMenu();
    }
  }
);
