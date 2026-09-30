declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

import morphdom from 'morphdom';
import { deriveScreenChanges } from '../editToolPath';
import type { WebviewSnapshot } from '../../state/types';
import { installCustomTooltips } from './customTooltip';
import {
  COMPOSER_FIELD_ID,
  COPIED_ICON_SVG,
  PREVIEW_DIALOG_ID,
  SEND_BUTTON_ID,
  escapeHtml,
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
installCustomTooltips();

// Wiring guard for morphdom: renderNow re-runs the event wiring on every render,
// but morphdom REUSES DOM nodes, so their listeners persist. bindOnce binds each
// element's listeners exactly once (in the render pass where the node first
// appears) and skips nodes carried over from a previous pass — while still
// allowing multiple listeners on the same element within a single pass.
let currentWirePass = 0;
const lastWiredPass = new WeakMap<EventTarget, number>();
function bindOnce<K extends keyof HTMLElementEventMap>(
  el: EventTarget | null | undefined,
  event: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): void {
  if (!el) {
    return;
  }
  const seen = lastWiredPass.get(el);
  if (seen !== undefined && seen !== currentWirePass) {
    return; // node reused from an earlier render pass — already wired
  }
  lastWiredPass.set(el, currentWirePass);
  el.addEventListener(event, handler as EventListener, options);
}

// #6 — inline slash-command autocomplete state.
let slashCommands: Array<{ name: string; description: string }> | null = null;
let slashRequested = false;
let slashIndex = 0;
let slashMatches: Array<{ name: string; description: string }> = [];

function composerField(): HTMLTextAreaElement | null {
  return document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
}

// User prompts in this chat, oldest->newest (deduped), for history navigation.
function promptHistory(): string[] {
  const messages = currentSnapshot?.messages ?? [];
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = (m.text ?? '').trim();
      if (text && out[out.length - 1] !== text) {
        out.push(text);
      }
    }
  }
  return out;
}

function exitHistory(): void {
  historyIndex = -1;
  historyStash = undefined;
}

// Returns true if the key was consumed (caller should preventDefault).
function navigateHistory(ta: HTMLTextAreaElement, direction: 'older' | 'newer'): boolean {
  const items = promptHistory();
  if (items.length === 0) {
    return false;
  }
  if (direction === 'older') {
    if (historyIndex === -1) {
      historyStash = ta.value;
      historyIndex = items.length - 1;
    } else if (historyIndex > 0) {
      historyIndex -= 1;
    } else {
      return true; // already at the oldest — consume but don't move
    }
  } else {
    if (historyIndex === -1) {
      return false;
    }
    if (historyIndex < items.length - 1) {
      historyIndex += 1;
    } else {
      // Past the newest entry: restore the draft that was in progress.
      ta.value = historyStash ?? '';
      exitHistory();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      autosizeComposer(ta);
      vscode.postMessage({ type: 'setDraft', text: ta.value, resetSeq: lastComposerResetSeq });
      return true;
    }
  }
  ta.value = items[historyIndex] ?? '';
  const end = ta.value.length;
  ta.setSelectionRange(end, end);
  autosizeComposer(ta);
  vscode.postMessage({ type: 'setDraft', text: ta.value, resetSeq: lastComposerResetSeq });
  return true;
}

// Auto-grow the composer to fit its content up to COMPOSER_MAX_LINES; beyond
// that it scrolls (with the current line kept in view). Avoids the fixed-height
// textarea showing an internal scrollbar for multi-line drafts.
const COMPOSER_MAX_LINES = 10;
function autosizeComposer(ta: HTMLTextAreaElement | null): void {
  if (!ta) {
    return;
  }
  ta.style.height = 'auto';
  const cs = getComputedStyle(ta);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4 || 18;
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const maxHeight = Math.round(line * COMPOSER_MAX_LINES + padY + border);
  ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
  // Keep the line being typed visible when the caret is at the end.
  if (ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
    ta.scrollTop = ta.scrollHeight;
  }
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
// Signature of the last FULLY-rendered snapshot's structure (everything except
// the growing text of the streaming answer). Lets us patch just the answer
// during a reply instead of rebuilding the whole transcript (flicker source).
let renderedStructureSig: string | undefined;
// Coalesce full re-renders while Pi is replying so the transcript doesn't
// rebuild (and flicker) several times per second as thinking/tool blocks stream.
let pendingSnapshot: WebviewSnapshot | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let lastFullRenderAt = 0;
const BUSY_MIN_RENDER_INTERVAL = 150;
// Prompt history (like the TUI): Up at the start of the input walks back through
// previously-sent prompts; Down walks forward; past the newest restores the
// in-progress draft. `historyIndex === -1` means not currently navigating.
let historyIndex = -1;
let historyStash: string | undefined;
// The text most recently submitted. The composer must NEVER re-show this while
// the authoritative draft is empty (guards the send-clear race that made an
// already-sent message reappear after Pi finished). Cleared when the user types.
let lastSubmittedText: string | undefined;
// Message-windowing scroll state.
let lastMessageKey: string | undefined;
let lastWindowOffset: number | undefined;
let loadOlderPending = false;
let followOnceRequested = false;
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
  exitHistory();
  // Optimistically clear the input immediately on submit (native chat feel),
  // unless there are pending attachments — those open a preview instead of
  // sending. If the send fails, the extension restores the draft via recovery.
  // Always clear optimistically — image/context sends included (they submit
  // immediately now, no preview popup).
  const textarea = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  if (textarea) {
    lastSubmittedText = textarea.value; // remember it so no later render restores it
    textarea.value = '';
  }
  vscode.postMessage({ type: 'requestSend', command, follow: followOnceRequested || undefined });
  followOnceRequested = false;
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

// While an inline message editor is open, suspend transcript re-renders. Every
// render rebuilds `#app` via innerHTML, which would destroy the editor the user
// is typing in. Snapshot churn (reconcile handshakes, streaming, status) fires
// constantly, so without this the editor vanishes the instant it's opened and
// the edit silently "does nothing". The latest snapshot is stashed and applied
// when editing ends.
let inlineEditActive = false;
let deferredSnapshot: WebviewSnapshot | undefined;
function beginInlineEdit(): void {
  inlineEditActive = true;
}
function endInlineEdit(applyDeferred: boolean): void {
  inlineEditActive = false;
  const pending = deferredSnapshot;
  deferredSnapshot = undefined;
  if (applyDeferred && pending) {
    render(pending);
  }
}

function render(snapshot: WebviewSnapshot): void {
  currentSnapshot = snapshot;
  if (!root) {
    return;
  }
  if (inlineEditActive) {
    // Defer: don't rebuild the DOM while the user is editing a message in place.
    deferredSnapshot = snapshot;
    return;
  }
  const isBusy = snapshot.connectionState === 'busy' || snapshot.isStreaming === true;
  const sig = structureSignature(snapshot);

  // Fast-path: only the answer text grew -> patch that ONE element and let the
  // typewriter reveal it; do NOT rebuild the transcript.
  if (isBusy && sig === renderedStructureSig) {
    const el = streamTarget();
    const text = lastStreamText(snapshot);
    if (el && typeof text === 'string') {
      el.setAttribute('data-raw', text);
      advanceTypewriter();
      keepPinnedToBottom();
      return;
    }
  }

  // Structural change while replying (new thinking/tool block, etc.): coalesce
  // to a calm max rate instead of rebuilding the DOM on every 400ms snapshot.
  if (isBusy) {
    pendingSnapshot = snapshot;
    const now = performance.now();
    const wait = BUSY_MIN_RENDER_INTERVAL - (now - lastFullRenderAt);
    if (wait <= 0) {
      lastFullRenderAt = now;
      pendingSnapshot = undefined;
      renderNow(snapshot);
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        lastFullRenderAt = performance.now();
        const pending = pendingSnapshot;
        pendingSnapshot = undefined;
        if (pending) {
          renderNow(pending);
        }
      }, wait);
    }
    return;
  }

  // Idle / final snapshot: render immediately (authoritative).
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  pendingSnapshot = undefined;
  lastFullRenderAt = performance.now();
  renderNow(snapshot);
}

// One corrective scrub per reset-seq: when a snapshot arrives whose draft is
// EXACTLY the text we just submitted, we render it as empty AND tell the
// extension to clear the persisted draft (stamped with the snapshot's own seq
// so it passes the stale-update gates). This heals every resurrection path —
// including fresh webviews after a draft-tab promote — at the single entry point.
let scrubbedForSeq: number | undefined;

function renderNow(snapshot: WebviewSnapshot): void {
  if (
    lastSubmittedText !== undefined &&
    lastSubmittedText.length > 0 &&
    snapshot.draft === lastSubmittedText
  ) {
    snapshot = { ...snapshot, draft: '' };
    if (scrubbedForSeq !== (snapshot.composerResetSeq ?? 0)) {
      scrubbedForSeq = snapshot.composerResetSeq ?? 0;
      vscode.postMessage({ type: 'setDraft', text: '', resetSeq: snapshot.composerResetSeq });
    }
  }
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
  // Work phases (and any details marked preserve-open) keep their state across
  // re-renders — morphdom rebuilds can otherwise snap them shut mid-reading.
  for (const el of Array.from(
    document.querySelectorAll<HTMLDetailsElement>('details[data-preserve-open][open]')
  )) {
    if (el.id) {
      openMenus.add(el.id);
    }
  }
  for (const id of ['attach-menu']) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (el?.open) {
      openMenus.add(id);
    }
  }

  // Patch the DOM instead of rebuilding it (root.innerHTML = ...). Rebuilding
  // destroyed and recreated every node on each update, which caused the heavy
  // flicker and reset the scroll position. morphdom reuses unchanged nodes, so
  // the transcript stays stable and the scroll position is preserved naturally.
  // A new wiring pass so bindOnce only wires freshly-added nodes.
  currentWirePass += 1;
  try {
    morphdom(root, `<div id="app">${renderChatApp(snapshot)}</div>`);
  } catch {
    // Defensive: if a morph ever fails, fall back to a full rebuild so the chat
    // never gets stuck.
    root.innerHTML = renderChatApp(snapshot);
  }
  renderedStructureSig = structureSignature(snapshot);

  // Robust sent-text-reappears guard: after an optimistic submit-clear we hold
  // `lastSubmittedText`. If ANY re-render (including an authoritative composer
  // reset, or one that arrives while the composer is unfocused) rebuilds the
  // textarea with exactly that submitted text, blank it. Typing resets
  // `lastSubmittedText` to undefined, so a genuine re-type is never blanked.
  if (lastSubmittedText !== undefined) {
    const submittedField = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
    if (submittedField && submittedField.value === lastSubmittedText) {
      submittedField.value = '';
    }
  }

  for (const id of openMenus) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (el) {
      el.open = true;
    }
  }

  const textarea = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  if (textarea && composerWasFocused && !authoritativeReset && document.hasFocus()) {
    if (typeof preservedValue === 'string') {
      // Never restore text that was just submitted while the draft is empty
      // (the extension cleared it) — that is the sent-text-reappears bug.
      const wouldReshowSubmitted =
        preservedValue.length > 0 &&
        preservedValue === lastSubmittedText &&
        (snapshot.draft ?? '') === '';
      textarea.value = wouldReshowSubmitted ? '' : preservedValue;
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
  // Size the composer to the (possibly restored) draft before wiring input.
  if (textarea) {
    autosizeComposer(textarea);
    bindOnce(textarea, 'input', () => {
      exitHistory(); // typing leaves history-navigation mode
      lastSubmittedText = undefined; // fresh text — stop guarding
      autosizeComposer(textarea);
      vscode.postMessage({
        type: 'setDraft',
        text: textarea.value,
        resetSeq: lastComposerResetSeq,
      });
    });
    bindOnce(textarea, 'focus', () => {
      vscode.postMessage({ type: 'setFocus', focus: 'composer' });
    });
    bindOnce(textarea, 'input', () => {
      updateSlashMenu();
      updateMentionMenu();
    });
    bindOnce(textarea, 'keyup', (event) => {
      // Arrow/click caret moves can enter/leave an @ context without an input event.
      if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
        updateMentionMenu();
      }
    });
    // Paste routing: images attach as thumbnail chips; file URIs (copied
    // from the Explorer / OS) attach via the same path as drag-drop. Text
    // pastes of ANY size stay ordinary text in the textarea (no chip, no
    // preventDefault) — what you paste is what you send.
    bindOnce(textarea, 'paste', (event) => {
      const clipboard = event.clipboardData;
      if (!clipboard) {
        return;
      }
      // Breadcrumb for live debugging ("image paste does nothing"): one line in
      // the Pi output channel names exactly what the clipboard delivered.
      const itemKinds = Array.from(clipboard.items ?? []).map(
        (entry) => `${entry.kind}:${entry.type}`
      );
      const fileKinds = Array.from(clipboard.files ?? []).map((file) => `file:${file.type}`);
      vscode.postMessage({
        type: 'diag',
        scope: 'paste',
        detail: JSON.stringify({ items: itemKinds, files: fileKinds }),
      });
      const attachImage = (file: File): void => {
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
      };
      let handledImage = false;
      for (const entry of Array.from(clipboard.items ?? [])) {
        if (entry.kind === 'file' && entry.type.startsWith('image/')) {
          const file = entry.getAsFile();
          if (!file) {
            continue;
          }
          event.preventDefault();
          handledImage = true;
          attachImage(file);
        }
      }
      // Electron/VS Code can deliver pasted images with EMPTY clipboard.items
      // but a populated clipboard.files — without this fallback the paste
      // silently does nothing (reported live).
      if (!handledImage) {
        for (const file of Array.from(clipboard.files ?? [])) {
          if (file.type.startsWith('image/')) {
            event.preventDefault();
            handledImage = true;
            attachImage(file);
          }
        }
      }
      if (handledImage) {
        return;
      }
      const uriList = clipboard.getData('text/uri-list');
      if (uriList) {
        const uris = uriList
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter((value) => value && value[0] !== '#');
        if (uris.length > 0) {
          event.preventDefault();
          for (const uri of uris) {
            vscode.postMessage({ type: 'attachFile', path: uri });
          }
          return;
        }
      }
    });
    // #9 — drag a file from the Explorer onto the composer to attach it.
    bindOnce(textarea, 'dragover', (event) => {
      event.preventDefault();
      textarea.classList.add('drop-target');
    });
    bindOnce(textarea, 'dragleave', () => textarea.classList.remove('drop-target'));
    bindOnce(textarea, 'drop', (event) => {
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
    bindOnce(textarea, 'keydown', (event) => {
      // #6/#9 — slash and mention menu navigation take priority when open.
      if (handleSlashKeydown(event) || handleMentionKeydown(event)) {
        return;
      }
      // Prompt history: Up when the caret is at the very start (or already
      // navigating) walks back; Down walks forward. Like the TUI.
      if (event.key === 'ArrowUp' && !event.isComposing) {
        const atStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0;
        if ((historyIndex >= 0 || atStart) && navigateHistory(textarea, 'older')) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === 'ArrowDown' && !event.isComposing && historyIndex >= 0) {
        if (navigateHistory(textarea, 'newer')) {
          event.preventDefault();
          return;
        }
      }
      // Enter submits (TUI-style); Shift+Enter inserts a newline. Cmd/Ctrl+Enter
      // also submits. IME composition Enter is ignored so it doesn't send mid-word.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        if (event.metaKey || event.ctrlKey) {
          followOnceRequested = true;
        }
        event.preventDefault();
        const sendButton = document.getElementById(SEND_BUTTON_ID) as HTMLButtonElement | null;
        if (!sendButton || sendButton.disabled) {
          return;
        }
        submitComposer(sendButton.dataset.sendCommand ?? 'prompt');
      }
    });
  }

  bindOnce(document.getElementById('folder-select'), 'change', (event) => {
    const target = event.target as HTMLSelectElement;
    vscode.postMessage({ type: 'switchFolder', folderUri: target.value });
  });

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-send-command]')
  )) {
    bindOnce(button, 'click', () => {
      previewReturnFocusId = button.id || SEND_BUTTON_ID;
      submitComposer(button.dataset.sendCommand ?? 'prompt');
    });
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-action]')
  )) {
    bindOnce(button, 'click', () => {
      const action = button.dataset.action;
      if (!action) {
        return;
      }
      if (action === 'toggleChatList') {
        toggleChatListOverlay();
        return;
      }
      if (action === 'toggleReview') {
        toggleReviewOverlay();
        return;
      }
      if (action === 'newChatSession') {
        // Dismiss any overlay first — the fresh chat must be visible, not
        // hidden behind the switcher/review layer.
        toggleChatListOverlay(false);
        toggleReviewOverlay(false);
        vscode.postMessage({ type: 'newChatSession' });
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
    bindOnce(button, 'click', () => {
      // Close the containing dropdown menu (if any) so it doesn't linger.
      button.closest('details')?.removeAttribute('open');
      vscode.postMessage({ type: 'executeCommand', command: button.dataset.command });
    });
  }

  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-remove-context]')
  )) {
    bindOnce(button, 'click', () => {
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
    bindOnce(button, 'click', () => {
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
    bindOnce(button, 'click', () => {
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
    bindOnce(button, 'click', () => {
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
    bindOnce(button, 'click', () => {
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
  for (const span of Array.from(root.querySelectorAll<HTMLElement>('.edit-approve'))) {
    const callId = span.dataset.ecid ?? '';
    const changesFor = () =>
      deriveScreenChanges((currentSnapshot?.messages ?? []) as never).filter((change) =>
        change.callId.startsWith(`${callId}-`)
      );
    bindOnce(span.querySelector<HTMLButtonElement>('.ed-keep')!, 'click', () => {
      span.classList.add('is-decided');
      span.innerHTML = '<span class="ed-done">✓ kept</span>';
    });
    bindOnce(span.querySelector<HTMLButtonElement>('.ed-undo')!, 'click', () => {
      for (const change of changesFor()) {
        vscode.postMessage({
          type: 'screenRevert',
          path: change.path,
          oldText: change.oldText,
          newText: change.newText,
        });
      }
      span.classList.add('is-decided');
      span.innerHTML = '<span class="ed-done">↩ undone</span>';
    });
    bindOnce(span.querySelector<HTMLButtonElement>('.ed-edit')!, 'click', () => {
      const change = changesFor()[0];
      if (change) {
        vscode.postMessage({
          type: 'screenOpenFile',
          path: change.path,
          needle:
            change.newText.split('\n').find((line) => line.trim().length > 4) ?? change.newText,
        });
      }
    });
  }

  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-open]'))) {
    bindOnce(button, 'click', () => {
      const path = button.getAttribute('data-file-open');
      if (path) {
        vscode.postMessage({ type: 'openFile', path });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-file-diff]'))) {
    bindOnce(button, 'click', () => {
      const path = button.getAttribute('data-file-diff');
      if (path) {
        vscode.postMessage({ type: 'openDiff', path });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-insert'))) {
    bindOnce(button, 'click', () => {
      const { text, language } = codeTextAndLang(button);
      if (text) {
        vscode.postMessage({ type: 'insertCode', text, language });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-newfile'))) {
    bindOnce(button, 'click', () => {
      const { text, language } = codeTextAndLang(button);
      if (text) {
        vscode.postMessage({ type: 'newFileFromCode', text, language });
      }
    });
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-copy'))) {
    bindOnce(button, 'click', () => {
      const code = button.closest('.code-wrap')?.querySelector('.code-block code');
      const text = code?.textContent ?? '';
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          const previous = button.innerHTML;
          button.innerHTML = COPIED_ICON_SVG;
          button.classList.add('is-copied');
          button.setAttribute('aria-label', 'Copied');
          setTimeout(() => {
            button.innerHTML = previous;
            button.classList.remove('is-copied');
            button.setAttribute('aria-label', 'Copy code');
          }, 1200);
        })
        .catch(() => undefined);
    });
  }

  bindOnce(document.getElementById(PREVIEW_DIALOG_ID), 'keydown', handlePreviewKeydown);

  // #1 — Markdown links open externally (no in-webview navigation).
  for (const link of Array.from(root.querySelectorAll<HTMLElement>('.md-link'))) {
    bindOnce(link, 'click', (event) => {
      event.preventDefault();
      const url = link.getAttribute('data-href');
      if (url) {
        vscode.postMessage({ type: 'openExternal', url });
      }
    });
  }

  // #4 — edit a user message INLINE (ChatGPT/Continue style): the bubble text
  // becomes an editable field in place; pressing Enter forks the session at that
  // message (dropping every message after it) and resubmits the edited text.
  // Esc cancels. Keyed by distance-from-bottom so it stays correct even when the
  // transcript is windowed (the tail is always shown).
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.msg-edit'))) {
    bindOnce(button, 'click', () => {
      vscode.postMessage({ type: 'debugLog', text: 'pencil clicked' });
      const article = button.closest('.message-card') as HTMLElement | null;
      if (!article || article.querySelector('.inline-edit')) {
        vscode.postMessage({ type: 'debugLog', text: 'pencil: no article or already editing' });
        return;
      }
      const body = article.querySelector('.message-body') as HTMLElement | null;
      if (!body) {
        vscode.postMessage({ type: 'debugLog', text: 'pencil: no .message-body found' });
        return;
      }
      const original = body.textContent?.trim() ?? '';
      const userCards = Array.from(root.querySelectorAll('.message-card.message-user'));
      const fromBottom = userCards.length - 1 - userCards.indexOf(article);

      const grow = (ta: HTMLTextAreaElement): void => {
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
      };
      const editor = document.createElement('div');
      editor.className = 'inline-edit';
      const ta = document.createElement('textarea');
      ta.className = 'inline-edit-field';
      ta.value = original;
      const hint = document.createElement('div');
      hint.className = 'inline-edit-hint';
      // Shows the CURRENT model, same as the composer's own status chip
      // (renderStatusChip: snapshot.model?.id) — was a generic "Different
      // model…" label, inconsistent with how the rest of the UI always
      // shows what's actually selected rather than a vague action name.
      const currentModelId = currentSnapshot?.model?.id
        ? String(currentSnapshot.model.id)
        : 'model';
      hint.innerHTML = `<span>Enter to save &amp; resend \u00b7 Esc to cancel</span><button type="button" class="inline-edit-model-btn" title="Resend with a different model (currently ${escapeHtml(currentModelId)})">\ud83d\udd00 ${escapeHtml(currentModelId)}</button>`;
      editor.append(ta, hint);

      const actions = article.querySelector('.msg-actions') as HTMLElement | null;
      body.style.display = 'none';
      if (actions) {
        actions.style.display = 'none';
      }
      body.insertAdjacentElement('afterend', editor);
      // Suspend re-renders so snapshot churn can't wipe this editor.
      beginInlineEdit();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      grow(ta);
      bindOnce(ta, 'input', () => grow(ta));

      const cancel = (): void => {
        editor.remove();
        body.style.display = '';
        if (actions) {
          actions.style.display = '';
        }
        // Resume rendering and repaint the authoritative state.
        endInlineEdit(true);
      };
      // Shared by Enter (same model) and the "Different model…" button
      // (opens the guided picker first, THEN resends with whatever was
      // chosen — this is what lets you edit AND retarget in one motion).
      const submitEdit = (pickModel: boolean): void => {
        vscode.postMessage({
          type: 'debugLog',
          text: `submitEdit invoked (pickModel=${pickModel}, fromBottom=${fromBottom})`,
        });
        const edited = ta.value.trim();
        if (!edited) {
          vscode.postMessage({ type: 'debugLog', text: 'submitEdit: empty text, cancelling' });
          cancel();
          return;
        }
        // Instant feedback: hide every message after this one until the
        // forked snapshot arrives.
        let sibling = article.nextElementSibling as HTMLElement | null;
        while (sibling) {
          sibling.style.display = 'none';
          sibling = sibling.nextElementSibling as HTMLElement | null;
        }
        editor.remove();
        body.textContent = edited;
        body.style.display = '';
        if (actions) {
          actions.style.display = '';
        }
        vscode.postMessage({
          type: 'forkAndSend',
          fromBottom,
          originalText: original,
          text: edited,
          pickModel: pickModel || undefined,
        });
        // Resume rendering; the fork's fresh snapshots repaint the truncated
        // transcript + new response. Discard the stale (pre-fork) deferred one.
        endInlineEdit(false);
      };
      bindOnce(ta, 'keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submitEdit(false);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      });
      const modelButton = editor.querySelector(
        '.inline-edit-model-btn'
      ) as HTMLButtonElement | null;
      vscode.postMessage({
        type: 'debugLog',
        text: `inline editor built; model button found=${Boolean(modelButton)}`,
      });
      bindOnce(modelButton, 'click', () => {
        vscode.postMessage({ type: 'debugLog', text: 'different-model button clicked' });
        submitEdit(true);
      });
    });
  }

  // #3 — copy a single message's output.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.api-error-copy'))) {
    bindOnce(button, 'click', () => {
      const text = button.dataset.copyText ?? '';
      void navigator.clipboard.writeText(text).then(() => {
        const original = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = original;
        }, 1200);
      });
    });
  }

  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.msg-copy'))) {
    bindOnce(button, 'click', () => {
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
    bindOnce(button, 'click', () => {
      const wrap = button.closest('.clampable');
      const expanded = wrap?.classList.toggle('expanded') ?? false;
      button.textContent = expanded ? 'Show less' : 'Show more';
    });
  }

  // JSON block: toggle between the structured table and the raw JSON.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.json-toggle'))) {
    bindOnce(button, 'click', () => {
      const block = button.closest('.json-block');
      const view = block?.querySelector('.json-block-view') as HTMLElement | null;
      const raw = block?.querySelector('.json-raw') as HTMLElement | null;
      if (!view || !raw) {
        return;
      }
      const showRaw = button.getAttribute('data-mode') !== 'raw';
      view.hidden = showRaw;
      raw.hidden = !showRaw;
      button.setAttribute('data-mode', showRaw ? 'raw' : 'table');
      button.setAttribute('aria-pressed', showRaw ? 'true' : 'false');
      button.textContent = showRaw ? 'Table' : 'Raw';
    });
  }

  const messagesEl = document.getElementById('messages');
  bindOnce(messagesEl, 'scroll', persistViewState, { passive: true });

  // #6 — jump-to-latest button appears when scrolled up.
  const jumpBtn = document.getElementById('jump-latest') as HTMLButtonElement | null;
  if (messagesEl && jumpBtn) {
    const updateJump = (): void => {
      const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      jumpBtn.hidden = distance < 120;
    };
    bindOnce(messagesEl, 'scroll', updateJump, { passive: true });
    bindOnce(jumpBtn, 'click', () => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      jumpBtn.hidden = true;
    });
    updateJump();
  }

  advanceTypewriter();
  startWorkingAnimation();
  applyScrollAndPaging(snapshot, scrollMetrics);
  applyFocus();
  ensureDockObserved(); // dock node can be swapped by morphdom — re-attach
  if (findOpen) {
    const anchor = findRanges[findIndex];
    runFind(findQuery, false);
    if (findAwaitingOlder) {
      findAwaitingOlder = false;
      const gained = findRanges.length - findCountBeforeOlder;
      if (gained > 0) {
        // Older content prepended `gained` matches — continue on the newest one.
        findIndex = gained - 1;
        updateFindCurrent(true);
      } else if (hasOlderHistory() && findQuery.trim()) {
        requestOlderForFind(); // keep walking further back
      }
    } else if (anchor) {
      // Keep the active hit stable across streaming re-renders.
      const index = findRanges.findIndex(
        (range) =>
          range.startContainer === anchor.startContainer && range.startOffset === anchor.startOffset
      );
      if (index >= 0) {
        findIndex = index;
        updateFindCurrent(false);
      }
    }
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
  input?.addEventListener('input', () => {
    runFind(input.value, true);
    // Land on the FIRST occurrence immediately — Enter then advances 2, 3, …
    // (previously nothing scrolled until Enter, which then skipped to #2).
    if (findRanges.length > 0) {
      updateFindCurrent(true);
    }
  });
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
    // A hit inside a collapsed work phase / result must become visible: open
    // every enclosing <details> before scrolling to it.
    let container = current.startContainer.parentElement;
    while (container) {
      const details = container.closest('details');
      if (!details) {
        break;
      }
      details.open = true;
      container = details.parentElement;
    }
    (current.startContainer.parentElement ?? null)?.scrollIntoView({ block: 'center' });
  }
}
let findAwaitingOlder = false;
let findCountBeforeOlder = 0;

function hasOlderHistory(): boolean {
  return currentSnapshot?.messageWindow?.hasOlder === true;
}

function requestOlderForFind(): void {
  findAwaitingOlder = true;
  findCountBeforeOlder = findRanges.length;
  const count = document.getElementById('pi-find-count');
  if (count) {
    count.textContent = 'searching history…';
  }
  vscode.postMessage({ type: 'loadOlder' });
}

function stepFind(direction: number): void {
  if (findRanges.length === 0) {
    // Nothing in the loaded window — keep pulling history until a match loads.
    if (hasOlderHistory()) {
      requestOlderForFind();
    }
    return;
  }
  const next = findIndex + direction;
  if (next < 0 && hasOlderHistory()) {
    // Ran past the oldest loaded match — continue INTO history (older messages
    // prepend; the continuation lands on the newest of the new matches).
    requestOlderForFind();
    return;
  }
  findIndex = (next + findRanges.length) % findRanges.length;
  updateFindCurrent(true);
}
// The composer floats over the transcript (true glass: content scrolls behind
// it). Keep the transcript's bottom padding in sync with the dock's real
// height so the last message is never hidden under it.
const composerClearance = new ResizeObserver((entries) => {
  for (const entry of entries) {
    document.documentElement.style.setProperty(
      '--composer-clearance',
      `${Math.ceil(entry.contentRect.height) + 48}px`
    );
  }
});
let observedDock: Element | null = null;
// morphdom can REPLACE the dock node (e.g. when the Working banner mounts) —
// re-attach the observer after every render or the clearance goes stale and
// the transcript slides under the input.
function ensureDockObserved(): void {
  const dock = document.querySelector('.composer-dock');
  if (dock && dock !== observedDock) {
    observedDock = dock;
    composerClearance.disconnect();
    composerClearance.observe(dock);
  }
}
ensureDockObserved();

// Turn navigator: j / k (or Alt+Down / Alt+Up) jump between YOUR prompts —
// each user message is a turn boundary. Skipped while typing or finding.
function turnAnchors(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('article.message-card.message-user'));
}

function jumpTurn(direction: 1 | -1): void {
  const anchors = turnAnchors();
  if (anchors.length === 0) {
    return;
  }
  const viewportAnchor = window.innerHeight * 0.25;
  let currentIndex = -1;
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index]!.getBoundingClientRect().top <= viewportAnchor + 2) {
      currentIndex = index;
    }
  }
  const next = Math.max(0, Math.min(anchors.length - 1, currentIndex + direction));
  const target = anchors[next];
  if (!target) {
    return;
  }
  target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  target.classList.add('find-flash');
  setTimeout(() => target.classList.remove('find-flash'), 700);
}

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  const typing =
    target &&
    (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
  if (typing) {
    return;
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      jumpTurn(event.key === 'ArrowDown' ? 1 : -1);
    }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return;
  }
  if (event.key === 'j' || event.key === 'k') {
    event.preventDefault();
    jumpTurn(event.key === 'j' ? 1 : -1);
  }
});

// ── One-surface switcher: the chat list slides OVER the chat ────────────────
interface ChatListItem {
  path: string;
  title: string;
  time: string;
  current?: boolean;
  workspace?: string;
  workspaceFolderUri?: string;
}
let chatListData: { current: ChatListItem[]; others: ChatListItem[] } | undefined;
let chatListFilter = '';

function chatListOverlay(): HTMLElement {
  let overlay = document.getElementById('chat-list-overlay');
  if (overlay) {
    return overlay;
  }
  overlay = document.createElement('div');
  overlay.id = 'chat-list-overlay';
  overlay.hidden = true;
  overlay.innerHTML =
    '<input id="cl-search" type="text" placeholder="Search chats…" aria-label="Search chats" />' +
    '<button type="button" id="cl-new" class="cl-new">✚ New Chat</button>' +
    '<div id="cl-list" class="cl-list" role="listbox"></div>';
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLInputElement>('#cl-search')?.addEventListener('input', (event) => {
    chatListFilter = (event.target as HTMLInputElement).value.toLowerCase();
    renderChatList();
  });
  overlay.querySelector('#cl-new')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'newChatSession' });
    toggleChatListOverlay(false);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay!.hidden) {
      event.preventDefault();
      toggleChatListOverlay(false);
    }
  });
  return overlay;
}

function toggleChatListOverlay(force?: boolean): void {
  const overlay = chatListOverlay();
  const show = force ?? overlay.hidden;
  overlay.hidden = !show;
  if (show) {
    // Anchor just below the command deck (fixed 37px overlapped it — the
    // layout's top padding pushes the deck lower than that).
    const deck = document.querySelector('.sb-deck');
    overlay.style.top = deck ? `${Math.ceil(deck.getBoundingClientRect().bottom) + 4}px` : '8px';
    vscode.postMessage({ type: 'requestChatList' });
    renderChatList();
    overlay.querySelector<HTMLInputElement>('#cl-search')?.focus();
  } else {
    document.getElementById(COMPOSER_FIELD_ID)?.focus();
  }
}

function renderChatList(): void {
  const list = document.getElementById('cl-list');
  if (!list) {
    return;
  }
  const match = (item: ChatListItem): boolean =>
    !chatListFilter || item.title.toLowerCase().includes(chatListFilter);
  const row = (item: ChatListItem, meta: string): string =>
    `<div class="cl-item${item.current ? ' is-current' : ''}"><button type="button" class="cl-open" data-path="${item.path.replaceAll('"', '&quot;')}" data-ws="${item.workspaceFolderUri ?? ''}"><span class="cl-title">${item.title.replaceAll('<', '&lt;')}</span><span class="cl-meta">${meta}</span></button><button type="button" class="cl-del" data-path="${item.path.replaceAll('"', '&quot;')}" data-title="${item.title.replaceAll('"', '&quot;')}" title="Delete chat (permanent)">🗑</button></div>`;
  const current = (chatListData?.current ?? []).filter(match);
  const others = (chatListData?.others ?? []).filter(match);
  list.innerHTML =
    (current.length > 0
      ? `<div class="cl-sec">This workspace</div>` +
        current.map((item) => row(item, item.time)).join('')
      : '<div class="cl-sec">No chats yet</div>') +
    (others.length > 0
      ? `<details class="cl-others"><summary class="cl-sec">Other projects (${others.length})</summary>` +
        others.map((item) => row(item, `${item.workspace ?? ''} · ${item.time}`)).join('') +
        '</details>'
      : '');
  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('.cl-open'))) {
    button.addEventListener('click', () => {
      vscode.postMessage({
        type: 'openChatSession',
        path: button.dataset.path ?? '',
        workspaceFolderUri: button.dataset.ws || undefined,
      });
      toggleChatListOverlay(false);
    });
  }
  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('.cl-del'))) {
    button.addEventListener('click', () => {
      // Confirmation is a native modal on the extension side; the refreshed
      // list comes back as a chatList message either way.
      vscode.postMessage({
        type: 'deleteChatSession',
        path: button.dataset.path ?? '',
        title: button.dataset.title ?? undefined,
      });
    });
  }
}

// ── Review overlay: full surface over the chat, only reachable when there is
// something to review (the deck button itself is conditional). ─────────────
interface ReviewTurnData {
  index: number;
  title: string;
  time: string;
  files: Array<{ file: string; kind: string; added?: number; deleted?: number }>;
}
let reviewTurns: ReviewTurnData[] = [];

function reviewOverlay(): HTMLElement {
  let overlay = document.getElementById('review-overlay');
  if (overlay) {
    return overlay;
  }
  overlay = document.createElement('div');
  overlay.id = 'review-overlay';
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="rv-head"><span class="rv-title">Review π\u2019s changes</span><button type="button" id="rv-replay-all" class="screen-close" title="Replay the whole session, oldest turn first">▶ Session</button><button type="button" id="rv-close" class="screen-close" title="Close (Esc)">✕</button></div>' +
    '<div id="rv-list" class="rv-list"></div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#rv-close')?.addEventListener('click', () => toggleReviewOverlay(false));
  overlay
    .querySelector('#rv-replay-all')
    ?.addEventListener('click', () =>
      vscode.postMessage({ type: 'reviewAction', action: 'replaySession', turn: 0 })
    );
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay!.hidden) {
      toggleReviewOverlay(false);
    }
  });
  return overlay;
}

function toggleReviewOverlay(force?: boolean): void {
  const overlay = reviewOverlay();
  const show = force ?? overlay.hidden;
  overlay.hidden = !show;
  if (show) {
    const deck = document.querySelector('.sb-deck');
    overlay.style.top = deck ? `${Math.ceil(deck.getBoundingClientRect().bottom) + 4}px` : '8px';
    vscode.postMessage({ type: 'requestReview' });
  }
}

function renderReview(): void {
  const list = document.getElementById('rv-list');
  if (!list) {
    return;
  }
  if (reviewTurns.length === 0) {
    list.innerHTML = '<div class="cl-sec">Nothing to review</div>';
    return;
  }
  list.innerHTML = reviewTurns
    .map((turn, order) => {
      const files = turn.files
        .map((file) => {
          const stat =
            file.added !== undefined || file.deleted !== undefined
              ? ` <span class="rv-stat"><span class="sc-add">+${file.added ?? 0}</span> <span class="sc-del">−${file.deleted ?? 0}</span></span>`
              : '';
          const name = file.file.split('/').pop() ?? file.file;
          return `<div class="rv-file"><button type="button" class="rv-open" data-turn="${turn.index}" data-file="${file.file.replaceAll('"', '&quot;')}" title="${file.file} — open diff">${name}${stat}</button><button type="button" class="rv-inline" data-turn="${turn.index}" data-file="${file.file.replaceAll('"', '&quot;')}" title="Review line by line IN the file (hunk controls)">≣</button><button type="button" class="rv-undo" data-turn="${turn.index}" data-file="${file.file.replaceAll('"', '&quot;')}" title="Revert this file">↩</button></div>`;
        })
        .join('');
      return `<details class="rv-turn"${order === 0 ? ' open' : ''}><summary><span class="rv-turn-title">${turn.title.replaceAll('<', '&lt;')} · ${turn.time}</span><span class="rv-turn-meta">${turn.files.length} file${turn.files.length === 1 ? '' : 's'}</span><button type="button" class="rv-replay" data-turn="${turn.index}" title="Replay this turn: watch each changed file, in order">▶</button><button type="button" class="rv-revert-turn" data-turn="${turn.index}" title="Revert the whole turn">↩ all</button></summary>${files}</details>`;
    })
    .join('');
  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('.rv-open'))) {
    button.addEventListener('click', () =>
      vscode.postMessage({
        type: 'reviewAction',
        action: 'diff',
        turn: Number(button.dataset.turn),
        file: button.dataset.file,
      })
    );
  }
  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('.rv-inline'))) {
    button.addEventListener('click', () =>
      vscode.postMessage({
        type: 'reviewAction',
        action: 'inline',
        turn: Number(button.dataset.turn),
        file: button.dataset.file,
      })
    );
  }
  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('.rv-undo'))) {
    button.addEventListener('click', () =>
      vscode.postMessage({
        type: 'reviewAction',
        action: 'revertFile',
        turn: Number(button.dataset.turn),
        file: button.dataset.file,
      })
    );
  }
  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('.rv-replay'))) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({
        type: 'reviewAction',
        action: 'replayTurn',
        turn: Number(button.dataset.turn),
      });
    });
  }
  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('.rv-revert-turn'))) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({
        type: 'reviewAction',
        action: 'revertTurn',
        turn: Number(button.dataset.turn),
      });
    });
  }
}

// Approvals answer to the keyboard: Y = Allow, N = Deny (skipped while
// typing). The highest-friction agentic moment shouldn't need the mouse.
window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key !== 'y' && key !== 'n') {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
  ) {
    return;
  }
  const button = document.querySelector<HTMLButtonElement>(
    key === 'y' ? '.approval-allow' : '.approval-deny'
  );
  if (button) {
    event.preventDefault();
    button.click();
  }
});

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

// A signature of everything that affects the DOM structure EXCEPT the growing
// text of the last message's answer block. Two consecutive streaming snapshots
// (only the answer grew) share a signature, so we can patch instead of rebuild.
function structureSignature(s: WebviewSnapshot): string {
  const n = s.messages.length;
  const msgs = s.messages
    .map((m, i) => {
      const isLast = i === n - 1;
      const blocks = (m.blocks ?? [])
        .map((block) => {
          const b = block as { kind: string; text?: string; name?: string; isError?: boolean };
          const isAnswer = b.kind === 'text';
          const textLen = isLast && isAnswer ? '' : String((b.text ?? '').length);
          return `${b.kind}:${b.name ?? ''}:${textLen}:${b.isError ? 'E' : ''}`;
        })
        .join(',');
      const textLen = isLast ? '' : String((m.text ?? '').length);
      return `${m.role}:${m.id}:${textLen}:[${blocks}]`;
    })
    .join('#');
  return (
    `${msgs}|${s.connectionState}|${s.isCompacting ? 1 : 0}` +
    `|q${(s.queue?.steering.length ?? 0) + (s.queue?.followUp.length ?? 0)}` +
    `|a${s.approvals?.length ?? 0}|p${s.pendingContextItems.length}/${s.pendingImages.length}`
  );
}

// Text of the last message's answer block — what the streaming element reveals.
function lastStreamText(s: WebviewSnapshot): string | undefined {
  const m = s.messages[s.messages.length - 1];
  if (!m || m.role !== 'assistant') {
    return undefined;
  }
  const blocks = m.blocks ?? [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i] as { kind?: string; text?: string } | undefined;
    if (b?.kind === 'text') {
      return b.text ?? '';
    }
  }
  return m.text ?? '';
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
    if (event.data?.type === 'reviewData') {
      reviewTurns = (event.data as unknown as { turns?: ReviewTurnData[] }).turns ?? [];
      renderReview();
      return;
    }
    if (event.data?.type === 'chatList') {
      const payload = event.data as unknown as {
        current?: ChatListItem[];
        others?: ChatListItem[];
      };
      chatListData = { current: payload.current ?? [], others: payload.others ?? [] };
      renderChatList();
      return;
    }
    if (event.data?.type === 'find') {
      openFind();
      return;
    }
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
