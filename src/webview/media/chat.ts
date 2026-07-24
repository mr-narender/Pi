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
  shouldClearSnapshotFocus,
} from '../render';

const vscode = acquireVsCodeApi();
const root = document.getElementById('app');
let currentSnapshot: WebviewSnapshot | undefined;
let pendingFocusTargetId: string | undefined;
let pendingFocusFallbackId: string | undefined;
let previewReturnFocusId: string | undefined;
let lastComposerResetSeq: number | undefined;
// Message-windowing scroll state.
let lastMessageKey: string | undefined;
let lastWindowOffset: number | undefined;
let loadOlderPending = false;
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

function render(snapshot: WebviewSnapshot): void {
  currentSnapshot = snapshot;
  if (!root) {
    return;
  }

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
  textarea?.addEventListener('keydown', (event) => {
    // Submit with Cmd+Enter (macOS) or Ctrl+Enter.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
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

  startWorkingAnimation();
  applyScrollAndPaging(snapshot, scrollMetrics);
  applyFocus();
}

const WORKING_FRAMES: Record<string, string[]> = {
  braille: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  earth: ['🌍', '🌎', '🌏'],
  moon: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
};
let workingTimer: ReturnType<typeof setInterval> | undefined;
function startWorkingAnimation(): void {
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = undefined;
  }
  const glyph = document.querySelector('.working .working-glyph') as HTMLElement | null;
  const container = document.querySelector('.working');
  if (!glyph || !container) {
    return;
  }
  const anim = container.getAttribute('data-anim') ?? 'braille';
  if (anim === 'dolphin') {
    glyph.textContent = '🐬';
    return;
  }
  const frames = WORKING_FRAMES[anim];
  if (!frames) {
    return; // dots / bars are pure CSS
  }
  let index = 0;
  glyph.textContent = frames[0] ?? '';
  workingTimer = setInterval(() => {
    index = (index + 1) % frames.length;
    glyph.textContent = frames[index] ?? '';
  }, 110);
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

  if (isNewResource) {
    // Opening/switching a chat: jump straight to the last message.
    messages.scrollTop = messages.scrollHeight;
  } else if (olderLoaded) {
    // Older batch was prepended: keep the viewport anchored on the message the
    // user was looking at (no jump).
    const delta = messages.scrollHeight - metrics.prevScrollHeight;
    messages.scrollTop = metrics.prevScrollTop + delta;
    loadOlderPending = false;
  } else if (metrics.wasNearBottom) {
    // Live streaming while already near the bottom: stick to the bottom.
    messages.scrollTop = messages.scrollHeight;
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
    }
  }
);
