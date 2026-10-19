declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
};

import morphdom from 'morphdom';
import { isBlockingExtensionUi } from '../../rpc/protocol';
import { optionalModule } from './optionalModules';
import { isLiveWorking, workingLabel, WORKING_PHRASES } from '../working';
import { isCoreMenuCommand, parseCoreSlash } from '../../commands/coreSlash';
import { mergeLocalCommands } from '../../commands/coreCatalog';
import { deriveScreenChanges } from '../editToolPath';
import type { WebviewSnapshot } from '../../state/types';
import type { ModelTool, ModelToolsSnapshot } from '../../modelTools/types';
import { installCustomTooltips } from './customTooltip';
import {
  COMPOSER_FIELD_ID,
  COPIED_ICON_SVG,
  MERMAID_DIALOG_CLOSE_ID,
  MERMAID_DIALOG_ID,
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
type ActivityTab = 'output' | 'sources' | 'agents';
const activityTabs = new Map<string, ActivityTab>();
const disclosureOpen = new Map<string, boolean>();
let renderedDisclosureSession: string | undefined;
function selectActivityTab(panel: HTMLElement, tab: ActivityTab): void {
  const selectedTab = panel.querySelector(`[data-activity-tab="${tab}"]`) ? tab : 'output';
  activityTabs.set(panel.id, selectedTab);
  panel.dataset.selectedActivity = selectedTab;
  for (const button of panel.querySelectorAll<HTMLElement>('[data-activity-tab]')) {
    const selected = button.dataset.activityTab === selectedTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const view of panel.querySelectorAll<HTMLElement>('[data-activity-view]'))
    view.hidden = view.dataset.activityView !== selectedTab;
}
root?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLElement>('[data-inline-activity] [data-activity-tab]');
  if (!button) return;
  const tab = button.dataset.activityTab;
  const panel = button.closest<HTMLElement>('[data-inline-activity]')!;
  if (tab === 'output' || tab === 'sources' || tab === 'agents') selectActivityTab(panel, tab);
});
root?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const panel = (event.target as HTMLElement).closest<HTMLDetailsElement>(
      '[data-inline-activity], #chat-settings'
    );
    if (panel?.open) {
      event.preventDefault();
      event.stopPropagation();
      panel.open = false;
      panel.querySelector<HTMLElement>(':scope > summary')?.focus();
      return;
    }
  }
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-activity-tab]');
  if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const panel = button.closest<HTMLElement>('[data-inline-activity]')!;
  const tabs = (['output', 'sources', 'agents'] as const).filter((tab) =>
    panel.querySelector(`[data-activity-tab="${tab}"]`)
  );
  const index = tabs.findIndex((tab) => tab === button.dataset.activityTab);
  selectActivityTab(
    panel,
    event.key === 'Home'
      ? 'output'
      : event.key === 'End'
        ? tabs.at(-1)!
        : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!
  );
  panel.querySelector<HTMLElement>('[data-activity-tab][aria-selected="true"]')?.focus();
});

function restoreInspectorFocus(focused: HTMLElement | undefined): void {
  // Moving a keyed Details node can blur its summary even though the node survives.
  if (
    focused?.isConnected &&
    document.activeElement === document.body &&
    window.getSelection()?.isCollapsed !== false
  )
    focused.focus({ preventScroll: true });
}
let currentSnapshot: WebviewSnapshot | undefined;
let modelToolsSequence = 0;
let modelToolsFrame: string | undefined;
let modelToolsRequestId: string | undefined;
let modelToolsReported: ModelToolsSnapshot | undefined;
let modelToolsEditor:
  | {
      frame: string;
      originKey: string;
      requestId: string;
      revision?: string;
      tools: ModelTool[];
      names: Set<string>;
      pending?: 'load' | 'apply';
      message?: string;
    }
  | undefined;

function modelToolsFrameKey(snapshot: WebviewSnapshot): string {
  return JSON.stringify([commandSessionKey(snapshot), snapshot.catalogGeneration]);
}
function modelToolsIdle(snapshot: WebviewSnapshot): boolean {
  return (
    snapshot.connectionState === 'ready' &&
    !snapshot.isStreaming &&
    !snapshot.isCompacting &&
    !snapshot.switchingSession &&
    snapshot.bindingState !== 'cached' &&
    snapshot.isTrusted
  );
}
function prepareModelTools(snapshot: WebviewSnapshot): void {
  const frame = modelToolsFrameKey(snapshot);
  if (modelToolsFrame !== frame) {
    modelToolsEditor = undefined;
    modelToolsRequestId = undefined;
    modelToolsReported = undefined;
  }
  modelToolsFrame = frame;
  const report = snapshot.modelTools;
  if (
    !report ||
    report.originKey !== commandSessionKey(snapshot) ||
    (modelToolsRequestId && report.requestId !== modelToolsRequestId)
  )
    return;
  modelToolsReported = report;
  const editor = modelToolsEditor;
  if (!editor || report.requestId !== editor.requestId) return;
  if (report.status === 'ready' && editor.pending === 'load') {
    editor.tools = report.tools;
    editor.names = new Set(report.active);
    editor.revision = report.revision;
    editor.pending = undefined;
    editor.message = report.message;
  } else if (report.status === 'ready' && editor.pending === 'apply') {
    modelToolsEditor = undefined;
  } else if (['unknown', 'stale', 'unsupported'].includes(report.status)) {
    editor.pending = undefined;
    editor.revision = undefined;
    editor.message = `${report.message ?? 'Tool selection could not be confirmed.'} Cancel and Edit to refresh.`;
  }
}
function modelToolsView(snapshot: WebviewSnapshot): WebviewSnapshot {
  const report =
    modelToolsRequestId && snapshot.modelTools?.requestId !== modelToolsRequestId
      ? modelToolsReported
      : snapshot.modelTools;
  const editor = modelToolsEditor;
  return {
    ...snapshot,
    modelTools:
      editor && report && editor.tools.length ? { ...report, tools: editor.tools } : report,
  };
}
function syncModelToolsControls(): void {
  const section = document.querySelector<HTMLElement>('[data-model-tools]');
  if (!section || !currentSnapshot) return;
  const editor = modelToolsEditor;
  const editing = section.querySelector<HTMLElement>('[data-model-tools-editor]')!;
  editing.hidden = !editor || editor.pending === 'load';
  const edit = section.querySelector<HTMLButtonElement>('[data-model-tools-action="edit"]')!;
  edit.hidden = !!editor;
  const status = section.querySelector<HTMLElement>('[data-model-tools-status]')!;
  if (editor) {
    (section as HTMLDetailsElement).open = true;
    status.textContent =
      editor.pending === 'load'
        ? 'Loading tools from Pi…'
        : editor.pending === 'apply'
          ? 'Applying to this chat…'
          : (editor.message ?? 'Changes not applied');
    const disabled =
      !modelToolsIdle(currentSnapshot) ||
      !!editor.pending ||
      currentSnapshot.modelTools?.status === 'unsupported';
    for (const checkbox of section.querySelectorAll<HTMLInputElement>('[data-model-tool-name]')) {
      checkbox.checked = editor.names.has(checkbox.dataset.modelToolName!);
      checkbox.disabled = disabled;
    }
    section.querySelector<HTMLButtonElement>('[data-model-tools-action="apply"]')!.disabled =
      disabled || !editor.revision;
    section.querySelector<HTMLButtonElement>('[data-model-tools-action="cancel"]')!.disabled =
      editor.pending === 'apply';
  }
}
root?.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    '[data-model-tools-action]'
  );
  if (!button || button.disabled || !currentSnapshot) return;
  event.preventDefault();
  const action = button.dataset.modelToolsAction;
  if (action === 'cancel') {
    if (modelToolsEditor?.pending === 'apply') return;
    modelToolsEditor = undefined;
    syncModelToolsControls();
    document.querySelector<HTMLButtonElement>('[data-model-tools-action="edit"]')?.focus();
    return;
  }
  if (!modelToolsIdle(currentSnapshot)) return;
  if (action === 'edit') {
    if (modelToolsEditor) return;
    const requestId = `${webviewGeneration}:tools:${++modelToolsSequence}`;
    modelToolsRequestId = requestId;
    modelToolsEditor = {
      frame: modelToolsFrameKey(currentSnapshot),
      originKey: commandSessionKey(currentSnapshot),
      requestId,
      tools: [],
      names: new Set(),
      pending: 'load',
    };
    syncModelToolsControls();
    vscode.postMessage({
      type: 'modelToolsRequest',
      originKey: modelToolsEditor.originKey,
      requestId,
    });
  } else if (
    action === 'apply' &&
    modelToolsEditor &&
    !modelToolsEditor.pending &&
    modelToolsEditor.revision
  ) {
    const editor = modelToolsEditor;
    const requestId = `${webviewGeneration}:tools:${++modelToolsSequence}`;
    modelToolsRequestId = requestId;
    editor.requestId = requestId;
    editor.pending = 'apply';
    syncModelToolsControls();
    vscode.postMessage({
      type: 'modelToolsApply',
      originKey: editor.originKey,
      requestId,
      revision: editor.revision,
      names: editor.tools.filter((tool) => editor.names.has(tool.name)).map((tool) => tool.name),
    });
  }
});
root?.addEventListener('change', (event) => {
  const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>(
    '[data-model-tool-name]'
  );
  const editor = modelToolsEditor;
  if (
    !checkbox ||
    !editor ||
    editor.pending ||
    !currentSnapshot ||
    !modelToolsIdle(currentSnapshot)
  )
    return;
  const name = checkbox.dataset.modelToolName!;
  if (!editor.tools.some((tool) => tool.name === name)) return;
  if (checkbox.checked) editor.names.add(name);
  else editor.names.delete(name);
  editor.message = undefined;
  syncModelToolsControls();
});
let mermaidDialogSrc: string | undefined;
let mermaidDialogKey: string | undefined;
let mermaidReturnFocus: HTMLElement | undefined;
let mermaidRenderId = 0;
const mermaidSvgCache = new Map<string, Promise<string>>();
installCustomTooltips();
document.addEventListener('pi-highlight-ready', () => {
  if (currentSnapshot && !isLiveWorking(currentSnapshot)) renderNow(currentSnapshot);
});

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

// Also used after an incremental inspector patch, without touching the composer.
function bindActivityActions(container: HTMLElement): void {
  for (const span of container.querySelectorAll<HTMLElement>('.edit-approve')) {
    const callId = span.dataset.ecid ?? '';
    bindOnce(span.querySelector('.ed-keep'), 'click', () => {
      span.classList.add('is-decided');
      span.innerHTML = '<span class="ed-done">✓ kept</span>';
    });
    bindOnce(span.querySelector<HTMLButtonElement>('.ed-undo'), 'click', () => {
      const button = span.querySelector<HTMLButtonElement>('.ed-undo')!;
      button.disabled = true;
      button.textContent = 'Undoing…';
      vscode.postMessage({ type: 'screenRevert', callId });
    });
    bindOnce(span.querySelector('.ed-edit'), 'click', () => {
      const change = deriveScreenChanges((currentSnapshot?.messages ?? []) as never).find((item) =>
        item.callId.startsWith(`${callId}-`)
      );
      if (change)
        vscode.postMessage({
          type: 'screenOpenFile',
          path: change.path,
          needle:
            change.newText.split('\n').find((line) => line.trim().length > 4) ?? change.newText,
        });
    });
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-ide-location]')) {
    bindOnce(button, 'click', () =>
      vscode.postMessage({
        type: 'openIdeLocation',
        path: button.dataset.ideLocation,
        line: Number(button.dataset.ideLine),
        character: Number(button.dataset.ideCharacter),
      })
    );
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>(
    '[data-file-open], [data-file-diff]'
  )) {
    bindOnce(button, 'click', () => {
      const path = button.dataset.fileOpen ?? button.dataset.fileDiff;
      if (path)
        vscode.postMessage({
          type: button.hasAttribute('data-file-open') ? 'openFile' : 'openDiff',
          path,
        });
    });
  }
  for (const link of container.querySelectorAll<HTMLElement>('.md-link')) {
    bindOnce(link, 'click', (event) => {
      event.preventDefault();
      if (link.dataset.href) vscode.postMessage({ type: 'openExternal', url: link.dataset.href });
    });
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>('.code-showmore')) {
    bindOnce(button, 'click', () => {
      const expanded = button.closest('.clampable')?.classList.toggle('expanded') ?? false;
      button.textContent = expanded ? 'Show less' : 'Show more';
    });
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>('.json-toggle')) {
    bindOnce(button, 'click', () => {
      const block = button.closest('.json-block');
      const view = block?.querySelector<HTMLElement>('.json-block-view');
      const raw = block?.querySelector<HTMLElement>('.json-raw');
      if (!view || !raw) return;
      const showRaw = button.dataset.mode !== 'raw';
      view.hidden = showRaw;
      raw.hidden = !showRaw;
      button.dataset.mode = showRaw ? 'raw' : 'table';
      button.setAttribute('aria-pressed', String(showRaw));
      button.textContent = showRaw ? 'Table' : 'Raw';
    });
  }
  bindCodeControls(container);
}

// #6 — inline slash-command autocomplete state.
const localSlashCommands = () =>
  mergeLocalCommands([]).map((item) => ({
    name: item.name as string,
    description: item.description as string,
  }));
let slashCommands: Array<{ name: string; description: string }> = localSlashCommands();
let slashRequested = false;
let slashRequestId: string | undefined;
let slashRequestSequence = 0;
let slashAttempts = 0;
let slashRetryAfter = 0;
let slashComplete = false;
let slashContext: string | undefined;
let slashIndex = 0;
let slashMatches: Array<{ name: string; description: string }> = [];

function composerField(): HTMLTextAreaElement | null {
  return document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
}
function syncContextualSteer(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-contextual-steer]');
  if (button)
    button.hidden =
      !currentSnapshot ||
      !isLiveWorking(currentSnapshot) ||
      currentSnapshot.isCompacting === true ||
      !composerField()?.value.trim();
}
let editingComposer = false;
function replaceComposerText(field: HTMLTextAreaElement, text: string): void {
  if (field.value === text) return;
  field.focus();
  field.select();
  editingComposer = true;
  try {
    // Native editing retains Undo; the caller owns draft/send notification ordering.
    document.execCommand?.(text ? 'insertText' : 'delete', false, text);
    if (field.value !== text) field.value = text;
  } finally {
    editingComposer = false;
    syncContextualSteer();
  }
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
      editRevision++;
      replaceComposerText(ta, historyStash ?? '');
      exitHistory();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      autosizeComposer(ta);
      vscode.postMessage({ type: 'setDraft', text: ta.value, resetSeq: lastComposerResetSeq });
      return true;
    }
  }
  editRevision++;
  replaceComposerText(ta, items[historyIndex] ?? '');
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
  replaceComposerText(field, `/${name} `);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  closeSlashMenu();
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  // Click, Enter and Tab explicitly activate a core menu; other completions
  // still only insert text. Arrow/highlight never reaches this path.
  if (isCoreMenuCommand(field.value)) submitComposer('prompt');
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
    const activate = (event: MouseEvent) => {
      event.preventDefault();
      if (item.isConnected) acceptSlash(cmd.name);
    };
    item.addEventListener('mousedown', activate);
    item.addEventListener('click', activate);
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
  // Further retries require a later user/snapshot event and a cooldown; no polling.
  if (!slashComplete && !slashRequested && slashAttempts >= 2 && Date.now() >= slashRetryAfter)
    slashAttempts = 0;
  if (
    !slashComplete &&
    !slashRequested &&
    slashAttempts < 2 &&
    (currentSnapshot?.connectionState === 'ready' || currentSnapshot?.connectionState === 'busy')
  ) {
    slashRequested = true;
    slashAttempts++;
    slashRequestId = `${webviewGeneration}:catalog:${++slashRequestSequence}`;
    vscode.postMessage({ type: 'requestSlashCommands', requestId: slashRequestId });
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
  if (event.isComposing || (event.key === 'Enter' && event.shiftKey)) return false;
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
    replaceComposerText(field, field.value.slice(0, ctx.start) + field.value.slice(caret));
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
let renderedComposerKey: string | undefined;
let appliedFocusRequest: string | undefined;
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
let editRevision = 0;
let renderedEditRevision = 0;
let pendingSend: { sessionKey: string; frame: number | undefined; revision: number } | undefined;
let submissionSequence = 0;
const webviewGeneration = `${Date.now()}-${Math.random()}`;
let pendingLocalCommand:
  | {
      draft: string;
      consumed?: string;
      blocked?: boolean;
      frame?: number;
      sessionKey?: string;
      revision: number;
      id: string;
    }
  | undefined;
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

function commandSessionKey(snapshot: WebviewSnapshot | undefined): string {
  return JSON.stringify([snapshot?.sessionFile, snapshot?.sessionId]);
}

let outboxSubmission:
  | {
      id: string;
      originKey: string;
      frame: number;
      revision: number;
      text: string;
      attachments: string;
      pending: boolean;
      key?: string;
    }
  | undefined;
const outboxComposing = new WeakSet<Element>();
const extensionUiComposing = new WeakSet<Element>();
const extensionUiPending = new Set<string>();
const extensionUiProposals = new Map<
  string,
  { originKey: string; frame: number; revision: number; attachments: string }
>();
let extensionUiDraftSubmission:
  | {
      requestKey: string;
      originKey: string;
      generation?: number;
      frame: number;
      revision: number;
      text: string;
      attachments: string;
      pending: boolean;
      acknowledgedReset?: number;
    }
  | undefined;
let extensionUiDraftRebase:
  | { originKey: string; generation?: number; resetSeq: number }
  | undefined;
function prepareExtensionUi(snapshot: WebviewSnapshot): void {
  const keys = new Set((snapshot.approvals ?? []).map((item) => item.requestKey));
  for (const key of extensionUiPending) if (!keys.has(key)) extensionUiPending.delete(key);
  for (const key of extensionUiProposals.keys())
    if (!keys.has(key)) extensionUiProposals.delete(key);
  for (const request of snapshot.approvals ?? []) {
    if (request.requestKey && request.responseError && !request.responseState)
      extensionUiPending.delete(request.requestKey);
    if (
      !request.requestKey ||
      request.method !== 'set_editor_text' ||
      extensionUiProposals.has(request.requestKey) ||
      typeof request.draftResetSeq !== 'number'
    )
      continue;
    extensionUiProposals.set(request.requestKey, {
      originKey: commandSessionKey(snapshot),
      frame: request.draftResetSeq,
      revision: editRevision,
      attachments: attachmentKey(snapshot),
    });
  }
}
function preserveExtensionUiComposer(snapshot: WebviewSnapshot): WebviewSnapshot {
  const submission = extensionUiDraftSubmission;
  const ack = snapshot.extensionUiDraftAck;
  if (
    submission &&
    ((!submission.pending && !ack) ||
      submission.originKey !== commandSessionKey(snapshot) ||
      submission.generation !== snapshot.catalogGeneration)
  )
    extensionUiDraftSubmission = undefined;
  const lease = extensionUiDraftSubmission;
  const field = composerField();
  if (!lease)
    return ack &&
      ack.originKey === commandSessionKey(snapshot) &&
      renderedComposerKey === commandSessionKey(snapshot) &&
      field
      ? {
          ...snapshot,
          draft: field.value,
          composerResetSeq: lastComposerResetSeq,
          pendingContextItems: currentSnapshot?.pendingContextItems ?? snapshot.pendingContextItems,
          pendingImages: currentSnapshot?.pendingImages ?? snapshot.pendingImages,
        }
      : snapshot;
  const matches =
    ack?.requestKey === lease.requestKey &&
    ack.originKey === lease.originKey &&
    ack.frame === lease.frame;
  const accepted =
    matches &&
    ack.accepted &&
    snapshot.composerResetSeq === lease.frame + 1 &&
    (lease.pending || lease.acknowledgedReset === snapshot.composerResetSeq);
  const newlyAccepted = accepted && lease.pending;
  if (newlyAccepted) lease.acknowledgedReset = snapshot.composerResetSeq;
  if (matches) lease.pending = false;
  const unchanged = editRevision === lease.revision && field?.value === lease.text;
  if (newlyAccepted && !unchanged)
    extensionUiDraftRebase = {
      originKey: lease.originKey,
      generation: lease.generation,
      resetSeq: snapshot.composerResetSeq!,
    };
  return {
    ...snapshot,
    ...(!accepted || !unchanged
      ? { draft: field?.value ?? currentSnapshot?.draft ?? snapshot.draft }
      : {}),
    ...(!accepted ? { composerResetSeq: lease.acknowledgedReset ?? lastComposerResetSeq } : {}),
    ...(ack && (!accepted || attachmentKey(currentSnapshot) !== lease.attachments)
      ? {
          pendingContextItems: currentSnapshot?.pendingContextItems ?? snapshot.pendingContextItems,
          pendingImages: currentSnapshot?.pendingImages ?? snapshot.pendingImages,
        }
      : {}),
  };
}
function syncExtensionUiControls(): void {
  if (!currentSnapshot) return;
  for (const card of root?.querySelectorAll<HTMLElement>('[data-extension-request]') ?? []) {
    const key = card.dataset.extensionRequest;
    const request = currentSnapshot.approvals?.find((item) => item.requestKey === key);
    if (!key || !request) continue;
    const blocked =
      extensionUiPending.has(key) ||
      !!request.responseState ||
      currentSnapshot.switchingSession ||
      currentSnapshot.bindingState === 'cached' ||
      !['starting', 'handshaking', 'ready', 'busy'].includes(currentSnapshot.connectionState);
    for (const button of card.querySelectorAll<HTMLButtonElement>('.approval-btn')) {
      button.disabled = blocked;
      if (button.hasAttribute('data-ui-draft-use')) {
        const proposal = extensionUiProposals.get(key);
        button.disabled ||=
          extensionUiDraftSubmission?.pending === true ||
          !proposal ||
          typeof request.draftRevision !== 'number' ||
          proposal.frame !== currentSnapshot.composerResetSeq ||
          proposal.originKey !== commandSessionKey(currentSnapshot) ||
          proposal.revision !== editRevision ||
          proposal.attachments !== attachmentKey(currentSnapshot) ||
          extensionUiComposing.has(composerField()!);
      }
    }
    const field = card.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-ui-field]');
    if (field) {
      field.disabled = false;
      field.readOnly = blocked;
    }
  }
}
root?.addEventListener('input', (event) => {
  if ((event.target as HTMLElement | null)?.id === COMPOSER_FIELD_ID) syncExtensionUiControls();
});
root?.addEventListener('compositionstart', (event) => {
  if ((event.target as HTMLElement | null)?.id !== COMPOSER_FIELD_ID) return;
  extensionUiComposing.add(event.target as Element);
  syncExtensionUiControls();
});
root?.addEventListener('compositionend', (event) => {
  if ((event.target as HTMLElement | null)?.id !== COMPOSER_FIELD_ID) return;
  extensionUiComposing.delete(event.target as Element);
  syncExtensionUiControls();
});
let outboxEditFocus: { key: string; id: string } | undefined;
function attachmentKey(snapshot: WebviewSnapshot | undefined): string {
  return JSON.stringify([
    snapshot?.pendingContextItems.map((item) => item.itemId),
    snapshot?.pendingImages.map((item) => item.itemId),
  ]);
}
function preserveOutboxComposer(snapshot: WebviewSnapshot): WebviewSnapshot {
  const submission = outboxSubmission;
  if (submission && !submission.pending && !snapshot.outboxAck) {
    outboxSubmission = undefined;
    return snapshot;
  }
  if (submission?.key !== undefined && submission.key !== snapshot.outbox?.key) {
    outboxSubmission = undefined;
    return snapshot;
  }
  if (!submission || submission.originKey !== commandSessionKey(snapshot)) {
    outboxSubmission = undefined;
    return snapshot.outboxAck &&
      composerField() &&
      currentSnapshot?.outbox?.key === snapshot.outbox?.key &&
      renderedComposerKey === commandSessionKey(snapshot)
      ? {
          ...snapshot,
          draft: composerField()!.value,
          composerResetSeq: lastComposerResetSeq,
          pendingContextItems: currentSnapshot?.pendingContextItems ?? snapshot.pendingContextItems,
          pendingImages: currentSnapshot?.pendingImages ?? snapshot.pendingImages,
        }
      : snapshot;
  }
  const field = composerField();
  const ack = snapshot.outboxAck;
  const matches =
    ack?.submissionId === submission.id &&
    ack.originKey === submission.originKey &&
    ack.frame === submission.frame;
  const newlyAcknowledged = matches && submission.pending;
  if (newlyAcknowledged && (!ack.accepted || snapshot.composerResetSeq === submission.frame))
    pendingSend = undefined;
  if (matches) submission.pending = false;
  const unchanged = editRevision === submission.revision && field?.value === submission.text;
  const accepted = newlyAcknowledged && ack.accepted;
  const preserve = !accepted || !unchanged;
  return {
    ...snapshot,
    ...(preserve ? { draft: field?.value ?? currentSnapshot?.draft ?? snapshot.draft } : {}),
    ...(!newlyAcknowledged || !ack.accepted ? { composerResetSeq: lastComposerResetSeq } : {}),
    ...((!accepted && !!ack) ||
    (accepted && attachmentKey(currentSnapshot) !== submission.attachments)
      ? {
          pendingContextItems: currentSnapshot?.pendingContextItems ?? snapshot.pendingContextItems,
          pendingImages: currentSnapshot?.pendingImages ?? snapshot.pendingImages,
        }
      : {}),
  };
}

function submitComposer(command: string): void {
  if (
    outboxSubmission?.pending &&
    outboxSubmission.originKey === commandSessionKey(currentSnapshot)
  )
    return;
  if (pendingLocalCommand?.blocked && composerField()?.value === '') return;
  previewReturnFocusId = SEND_BUTTON_ID;
  exitHistory();
  // Optimistically clear the input immediately on submit (native chat feel),
  // unless there are pending attachments — those open a preview instead of
  // sending. If the send fails, the extension restores the draft via recovery.
  // Always clear optimistically — image/context sends included (they submit
  // immediately now, no preview popup).
  const textarea = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  if (
    textarea &&
    command === 'follow_up' &&
    currentSnapshot?.connectionState === 'busy' &&
    !parseCoreSlash(textarea.value)
  ) {
    outboxSubmission = {
      id: `${webviewGeneration}:${++submissionSequence}`,
      originKey: commandSessionKey(currentSnapshot),
      frame: currentSnapshot.composerResetSeq ?? 0,
      revision: editRevision,
      text: textarea.value,
      attachments: attachmentKey(currentSnapshot),
      pending: true,
      key: currentSnapshot.outbox?.key,
    };
    pendingSend = {
      sessionKey: outboxSubmission.originKey,
      frame: outboxSubmission.frame,
      revision: editRevision,
    };
    vscode.postMessage({ type: 'requestSend', command, submissionId: outboxSubmission.id });
    return;
  }
  outboxSubmission = undefined;
  if (textarea && parseCoreSlash(textarea.value)) {
    pendingSend = undefined;
    pendingLocalCommand = {
      draft: isCoreMenuCommand(textarea.value) ? '' : textarea.value,
      consumed: isCoreMenuCommand(textarea.value) ? textarea.value : undefined,
      revision: editRevision,
      blocked: isCoreMenuCommand(textarea.value),
      frame: currentSnapshot?.composerResetSeq,
      id: `${webviewGeneration}:${++submissionSequence}`,
      sessionKey: commandSessionKey(currentSnapshot),
    };
  } else {
    pendingLocalCommand = undefined;
  }
  if (textarea && pendingLocalCommand?.consumed) {
    replaceComposerText(textarea, '');
    autosizeComposer(textarea);
  }
  if (textarea && !pendingLocalCommand) {
    pendingSend = {
      sessionKey: commandSessionKey(currentSnapshot),
      frame: currentSnapshot?.composerResetSeq,
      revision: editRevision,
    };
    lastSubmittedText = textarea.value; // remember it so no later render restores it
    replaceComposerText(textarea, '');
  }
  vscode.postMessage({
    type: 'requestSend',
    command,
    submissionId: pendingLocalCommand?.id,
  });
}

function postDroppedFile(file: File): void {
  const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
  const fallbackLimit = isImage ? 3 * 1024 * 1024 : 512 * 1024;
  const limits = currentSnapshot?.attachmentLimits;
  const limit = (isImage ? limits?.imageBytes : limits?.fileBytes) ?? fallbackLimit;
  if (file.size > limit) {
    vscode.postMessage({
      type: 'dropFile',
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      data: '',
    });
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : '';
    const comma = result.indexOf(',');
    const data = comma >= 0 ? result.slice(comma + 1) : '';
    if (data) {
      vscode.postMessage({
        type: 'dropFile',
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        data,
      });
    }
  };
  reader.readAsDataURL(file);
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

function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

let mermaidReady: Promise<typeof import('mermaid').default> | undefined;
let mermaidFontFamily = 'system-ui, sans-serif';
function loadMermaid(): Promise<typeof import('mermaid').default> {
  return (mermaidReady ??= optionalModule('Mermaid')
    .then(({ default: mermaid }) => {
      const fontFamily = cssColor('--vscode-font-family', 'system-ui, sans-serif');
      mermaidFontFamily = fontFamily;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'base',
        htmlLabels: false,
        fontFamily,
        flowchart: { useMaxWidth: false, minNodeWidth: 0 },
        themeVariables: {
          background: 'transparent',
          fontFamily,
          primaryColor: cssColor('--vscode-editorWidget-background', '#f5f5f5'),
          primaryTextColor: cssColor('--vscode-editor-foreground', '#242424'),
          primaryBorderColor: cssColor('--vscode-panel-border', '#8a8a8a'),
          lineColor: cssColor('--vscode-descriptionForeground', '#666666'),
          edgeLabelBackground: cssColor('--vscode-editor-background', '#ffffff'),
        },
      });
      return mermaid;
    })
    .catch((error) => {
      mermaidReady = undefined;
      throw error;
    }));
}

function mermaidSvg(source: string): Promise<string> {
  const cached = mermaidSvgCache.get(source);
  if (cached) return cached;
  const rendered = loadMermaid()
    .then(async (mermaid) => {
      const { config } = await mermaid.parse(source);
      // CSP blocks Mermaid's temporary inline stylesheet, but that stylesheet
      // applies inside the resulting SVG image. Measure using the same fonts,
      // rather than inheriting the webview's smaller body text.
      const host = document.createElement('div');
      host.className = 'mermaid-measurement';
      host.setAttribute('aria-hidden', 'true');
      const container = document.createElement('div');
      container.style.fontFamily = mermaidFontFamily;
      container.style.fontSize = '16px';
      const font = config.themeVariables;
      if (typeof font?.fontFamily === 'string') container.style.fontFamily = font.fontFamily;
      if (typeof font?.fontSize === 'string' || typeof font?.fontSize === 'number')
        container.style.fontSize = String(font.fontSize);
      host.append(container);
      document.body.append(host);
      try {
        return await mermaid.render(`pi-mermaid-${(mermaidRenderId += 1)}`, source, container);
      } finally {
        host.remove();
      }
    })
    .then(({ svg }) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    .catch((error) => {
      mermaidSvgCache.delete(source);
      throw error;
    });
  if (mermaidSvgCache.size >= 50) {
    mermaidSvgCache.delete(mermaidSvgCache.keys().next().value!);
  }
  mermaidSvgCache.set(source, rendered);
  return rendered;
}

async function renderMermaidPreview(wrap: HTMLElement): Promise<void> {
  const source = wrap.querySelector('.mermaid-code code')?.textContent?.trim();
  const preview = wrap.querySelector<HTMLElement>('.mermaid-preview');
  const stage = preview?.querySelector<HTMLElement>('.mermaid-preview-stage');
  const error = preview?.querySelector<HTMLElement>('.mermaid-error');
  const expand = wrap.querySelector<HTMLButtonElement>('.mermaid-expand');
  if (!source || !stage || !error || !expand) return;
  if (stage.querySelector('.mermaid-image')) return;

  stage.setAttribute('aria-busy', 'true');
  error.hidden = true;
  expand.disabled = true;
  try {
    const src = await mermaidSvg(source);
    if (
      !wrap.isConnected ||
      wrap.querySelector('.mermaid-code code')?.textContent?.trim() !== source
    )
      return;
    const image = document.createElement('img');
    image.className = 'mermaid-image';
    image.alt = 'Rendered Mermaid diagram';
    image.src = src;
    stage.replaceChildren(image);
    stage.removeAttribute('aria-busy');
    expand.disabled = false;
  } catch {
    if (
      !wrap.isConnected ||
      wrap.querySelector('.mermaid-code code')?.textContent?.trim() !== source
    )
      return;
    stage.replaceChildren();
    stage.removeAttribute('aria-busy');
    error.hidden = false;
  }
}

function setMermaidView(wrap: HTMLElement, mode: 'code' | 'preview'): void {
  wrap.dataset.mermaidView = mode;
  const code = wrap.querySelector<HTMLElement>('.mermaid-code');
  const preview = wrap.querySelector<HTMLElement>('.mermaid-preview');
  if (code) code.hidden = mode !== 'code';
  if (preview) preview.hidden = mode !== 'preview';
  for (const button of Array.from(wrap.querySelectorAll<HTMLButtonElement>('.mermaid-toggle'))) {
    const active = button.dataset.mermaidMode === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (mode === 'preview') {
    if (wrap.closest('.js-stream-text') && wrap.dataset.mermaidComplete !== 'true') {
      const loading = wrap.querySelector('.mermaid-loading');
      if (loading) loading.textContent = 'Preview will appear when the response finishes.';
    } else {
      void renderMermaidPreview(wrap);
    }
  }
}

function mermaidKey(wrap: HTMLElement): string {
  const message = wrap.closest<HTMLElement>('[data-mid], [data-activity-id]');
  const index = Array.from(message?.querySelectorAll('.mermaid-wrap') ?? []).indexOf(wrap);
  return `${wrap.closest<HTMLElement>('.layout')?.dataset.mermaidSession ?? ''}:${message?.dataset.mid ?? message?.dataset.activityId ?? ''}:${index}`;
}

function bindCodeControls(container: HTMLElement): void {
  for (const button of Array.from(
    container.querySelectorAll<HTMLButtonElement>('.mermaid-toggle')
  )) {
    bindOnce(button, 'click', () => {
      const wrap = button.closest<HTMLElement>('.mermaid-wrap');
      const mode = button.dataset.mermaidMode;
      if (wrap && (mode === 'code' || mode === 'preview')) setMermaidView(wrap, mode);
    });
  }
  for (const button of Array.from(
    container.querySelectorAll<HTMLButtonElement>('.mermaid-expand')
  )) {
    bindOnce(button, 'click', () => {
      const wrap = button.closest<HTMLElement>('.mermaid-wrap');
      const src = wrap?.querySelector<HTMLImageElement>('.mermaid-image')?.src;
      if (!wrap || !src) return;
      mermaidDialogSrc = src;
      mermaidDialogKey = mermaidKey(wrap);
      mermaidReturnFocus = button;
      restoreMermaidDialog();
      document.getElementById(MERMAID_DIALOG_CLOSE_ID)?.focus();
    });
  }
  for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>('.code-copy'))) {
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
}

function closeMermaidDialog(): void {
  mermaidDialogSrc = undefined;
  mermaidDialogKey = undefined;
  const dialog = document.getElementById(MERMAID_DIALOG_ID);
  if (dialog) dialog.hidden = true;
  mermaidReturnFocus?.focus();
  mermaidReturnFocus = undefined;
}

function restoreMermaidDialog(): void {
  if (!mermaidDialogSrc || !mermaidDialogKey) return;
  const dialog = document.getElementById(MERMAID_DIALOG_ID);
  const output = dialog?.querySelector<HTMLImageElement>('.mermaid-dialog-output img');
  if (!dialog || !output) return;
  const source = Array.from(document.querySelectorAll<HTMLElement>('#messages .mermaid-wrap')).find(
    (wrap) => mermaidKey(wrap) === mermaidDialogKey
  );
  if (!source) {
    mermaidDialogSrc = undefined;
    mermaidDialogKey = undefined;
    mermaidReturnFocus = undefined;
    dialog.hidden = true;
    return;
  }
  const currentSrc = source.querySelector<HTMLImageElement>('.mermaid-image')?.src;
  if (currentSrc) mermaidDialogSrc = currentSrc;
  output.src = mermaidDialogSrc;
  output.hidden = false;
  dialog.hidden = false;
}

function handleMermaidDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMermaidDialog();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    document.getElementById(MERMAID_DIALOG_CLOSE_ID)?.focus();
  }
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
  const busy = isLiveWorking(snapshot);
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
  // VS Code resolves on/off/auto for its webviews. Raw OS media must not
  // override an explicit workbench "off"; standalone previews still use it.
  const vscodeBody = document.body.matches(
    '.vscode-light, .vscode-dark, .vscode-high-contrast, .vscode-high-contrast-light'
  );
  return (
    document.body.classList.contains('vscode-reduce-motion') ||
    (!vscodeBody && workingMotion.matches)
  );
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

function acceptsCommandReplacement(snapshot: WebviewSnapshot): boolean {
  const replacement = snapshot.localCommandReplacement;
  return !!(
    pendingLocalCommand &&
    replacement &&
    (snapshot.localCommandAck === pendingLocalCommand.id ||
      replacement.submissionId === pendingLocalCommand.id) &&
    replacement.originKey === pendingLocalCommand.sessionKey &&
    replacement.replacementKey === commandSessionKey(snapshot) &&
    replacement.frame === (pendingLocalCommand.frame ?? 0) &&
    (snapshot.composerResetSeq ?? 0) ===
      replacement.frame + (snapshot.localCommandAck === pendingLocalCommand.id ? 1 : 0)
  );
}

function rejectsLocalCommandAck(snapshot: WebviewSnapshot): boolean {
  if (snapshot.localCommandAck === undefined) {
    return false;
  }
  const composer = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  return (
    !pendingLocalCommand ||
    snapshot.localCommandAck !== pendingLocalCommand.id ||
    (pendingLocalCommand.sessionKey !== commandSessionKey(snapshot) &&
      !acceptsCommandReplacement(snapshot)) ||
    editRevision !== pendingLocalCommand.revision ||
    !composer ||
    composer.value !== pendingLocalCommand.draft
  );
}

function preserveComposerForRejectedAck(snapshot: WebviewSnapshot): WebviewSnapshot {
  if (!rejectsLocalCommandAck(snapshot)) {
    return snapshot;
  }
  const composer = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  // Keep model/transcript/status updates, but an unknown or obsolete reply has
  // no authority over this frame's composer (including a fresh generation).
  return {
    ...snapshot,
    draft: composer?.value ?? currentSnapshot?.draft ?? snapshot.draft,
    composerResetSeq: lastComposerResetSeq,
    pendingContextItems: currentSnapshot?.pendingContextItems ?? snapshot.pendingContextItems,
    pendingImages: currentSnapshot?.pendingImages ?? snapshot.pendingImages,
  };
}

function render(snapshot: WebviewSnapshot): void {
  if (workingDisposed) return;
  prepareModelTools(snapshot);
  prepareExtensionUi(snapshot);
  snapshot = preserveExtensionUiComposer(snapshot);
  snapshot = preserveOutboxComposer(snapshot);
  snapshot = preserveComposerForRejectedAck(snapshot);
  prepareTypewriter(snapshot);
  currentSnapshot = snapshot;
  syncContextualSteer();
  if (!isLiveWorking(snapshot)) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    pendingSnapshot = undefined;
    stopWorkingAnimation();
    stopWorkingPhrases();
    document.querySelector('.working-banner')?.remove();
  }
  if (!root) {
    return;
  }
  if (inlineEditActive) {
    // Defer: don't rebuild the DOM while the user is editing a message in place.
    deferredSnapshot = snapshot;
    return;
  }
  const isBusy = isLiveWorking(snapshot);
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
  streamPaintedNode = undefined;
  if (workingDisposed) return;
  const preserveReplacementDraft =
    pendingLocalCommand !== undefined &&
    editRevision !== pendingLocalCommand.revision &&
    acceptsCommandReplacement(snapshot);
  const sameChat = renderedComposerKey === commandSessionKey(snapshot);
  const disclosureSession = JSON.stringify(
    snapshot.sessionFile ? ['file', snapshot.sessionFile] : ['id', snapshot.sessionId]
  );
  const sameDisclosureSession = renderedDisclosureSession === disclosureSession;
  if (!sameChat) {
    lastSubmittedText = undefined;
    scrubbedForSeq = undefined;
  }
  if (!sameDisclosureSession) {
    activityTabs.clear();
    disclosureOpen.clear();
  }
  renderedDisclosureSession = disclosureSession;
  if (
    pendingLocalCommand &&
    pendingLocalCommand.sessionKey !== commandSessionKey(snapshot) &&
    !acceptsCommandReplacement(snapshot)
  )
    pendingLocalCommand = undefined;
  if (
    pendingLocalCommand &&
    (snapshot.localCommandConsumed === pendingLocalCommand.id ||
      snapshot.localCommandAck === pendingLocalCommand.id ||
      snapshot.composerResetSeq !== pendingLocalCommand.frame)
  )
    pendingLocalCommand.blocked = false;
  const rejectedAck = rejectsLocalCommandAck(snapshot);
  snapshot = preserveComposerForRejectedAck(snapshot);
  if (
    pendingLocalCommand?.consumed &&
    editRevision === pendingLocalCommand.revision &&
    pendingLocalCommand.sessionKey === commandSessionKey(snapshot) &&
    snapshot.draft === pendingLocalCommand.consumed
  ) {
    // Local-only echo suppression: never post an empty draft ahead of the
    // immutable invoking command being captured by the host route.
    snapshot = { ...snapshot, draft: composerField()?.value ?? '' };
  }
  if (
    !rejectedAck &&
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
  const preservedStart = composerWasFocused ? previousComposer.selectionStart : undefined;
  const preservedEnd = composerWasFocused ? previousComposer.selectionEnd : undefined;
  const composerKey = commandSessionKey(snapshot);
  const sameComposer = renderedComposerKey === composerKey;

  // An authoritative composer reset (send-clear, copy-to-composer, restore)
  // must overwrite the field even if it was focused.
  const resetSeq = snapshot.composerResetSeq;
  let authoritativeReset = resetSeq !== undefined && resetSeq !== lastComposerResetSeq;
  let rebaseDraft = false;
  if (extensionUiDraftRebase) {
    const rebase = extensionUiDraftRebase;
    extensionUiDraftRebase = undefined;
    if (
      previousComposer &&
      sameComposer &&
      rebase.originKey === composerKey &&
      rebase.generation === snapshot.catalogGeneration &&
      rebase.resetSeq === resetSeq
    ) {
      snapshot = { ...snapshot, draft: previousComposer.value };
      rebaseDraft = true;
    }
  }
  if (pendingSend && (pendingSend.sessionKey !== composerKey || resetSeq !== pendingSend.frame)) {
    if (
      previousComposer &&
      pendingSend.sessionKey === composerKey &&
      resetSeq === (pendingSend.frame ?? 0) + 1 &&
      !snapshot.draft &&
      editRevision !== pendingSend.revision
    ) {
      authoritativeReset = false;
      rebaseDraft = true;
    }
    pendingSend = undefined;
  }
  if (
    authoritativeReset &&
    pendingLocalCommand &&
    (pendingLocalCommand.sessionKey === commandSessionKey(snapshot) ||
      acceptsCommandReplacement(snapshot))
  ) {
    // A local-command ack must not overwrite input typed while its picker was
    // open, even when that input's host-side draft message is still in flight.
    if (
      previousComposer &&
      (editRevision !== pendingLocalCommand.revision ||
        previousComposer.value !== pendingLocalCommand.draft ||
        (snapshot.localCommandAck !== undefined &&
          snapshot.localCommandAck !== pendingLocalCommand.id))
    ) {
      authoritativeReset = false;
      snapshot = { ...snapshot, draft: previousComposer.value };
    }
    // Retain the latest identity: an older reply can arrive after this ack.
    // Legacy snapshots without a correlated ack are also revision-guarded.
  }
  if (
    authoritativeReset &&
    !snapshot.localCommandAck &&
    !snapshot.draft &&
    previousComposer &&
    editRevision !== renderedEditRevision &&
    parseCoreSlash(previousComposer.value)
  ) {
    authoritativeReset = false;
    snapshot = { ...snapshot, draft: previousComposer.value };
  }
  if (!rejectedAck) {
    renderedEditRevision = editRevision;
    lastComposerResetSeq = resetSeq;
  }
  // Keep the native textarea value (and undo buffer) intact before morphdom runs.
  if (previousComposer && (sameComposer || preserveReplacementDraft) && !authoritativeReset) {
    snapshot = { ...snapshot, draft: previousComposer.value };
  }
  if (rebaseDraft) {
    vscode.postMessage({ type: 'setDraft', text: snapshot.draft, resetSeq });
  }
  renderedComposerKey = composerKey;

  // Keep user choices even when a same-chat update temporarily omits a disclosure.
  for (const el of Array.from(
    document.querySelectorAll<HTMLDetailsElement>('details[data-preserve-open]')
  )) {
    if (el.id && sameDisclosureSession) {
      disclosureOpen.set(el.id, el.open);
    }
  }
  const openMenus = new Set<string>();
  for (const id of ['attach-menu']) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (el?.open) {
      openMenus.add(id);
    }
  }
  const mermaidModes = new Map(
    Array.from(document.querySelectorAll<HTMLElement>('.mermaid-wrap')).map((wrap) => [
      mermaidKey(wrap),
      wrap.dataset.mermaidView === 'code' ? ('code' as const) : ('preview' as const),
    ])
  );

  // Patch the DOM instead of rebuilding it (root.innerHTML = ...). Rebuilding
  // destroyed and recreated every node on each update, which caused the heavy
  // flicker and reset the scroll position. morphdom reuses unchanged nodes, so
  // the transcript stays stable and the scroll position is preserved naturally.
  // A new wiring pass so bindOnce only wires freshly-added nodes.
  const inspectorFocus =
    sameDisclosureSession &&
    document.hasFocus() &&
    document.activeElement?.closest('[data-inline-activity], #chat-settings')
      ? (document.activeElement as HTMLElement)
      : undefined;
  currentWirePass += 1;
  try {
    morphdom(
      root,
      `<div id="app">${renderChatApp(modelToolsView(snapshot), streamMessageId)}</div>`,
      {
        onBeforeElUpdated(from, to) {
          // Do not temporarily hide the selected inspector tab: that blurs its
          // focused disclosure before selectActivityTab restores the selection.
          if (sameDisclosureSession && from.hasAttribute('data-activity-view'))
            to.hidden = from.hidden;
          if (
            sameDisclosureSession &&
            from.tagName === 'DETAILS' &&
            from.hasAttribute('data-preserve-open') &&
            from.id === to.id
          )
            (to as HTMLDetailsElement).open = (from as HTMLDetailsElement).open;
          if (
            from.hasAttribute('data-ui-field') &&
            from.getAttribute('data-ui-field') === to.getAttribute('data-ui-field') &&
            from.getAttribute('data-ui-origin') === to.getAttribute('data-ui-origin')
          ) {
            (from as HTMLInputElement).readOnly = (to as HTMLInputElement).readOnly;
            return false;
          }
          if (
            from.hasAttribute('data-outbox-editor') &&
            from.getAttribute('data-outbox-editor-revision') ===
              to.getAttribute('data-outbox-editor-revision') &&
            from.getAttribute('data-outbox-editor-key') ===
              to.getAttribute('data-outbox-editor-key')
          ) {
            (from as HTMLTextAreaElement).readOnly = (to as HTMLTextAreaElement).readOnly;
            return false;
          }
          // Preserve CSS animation timelines and frame glyphs across remote snapshots.
          return !(
            from.id === 'pi-working' &&
            from.getAttribute('data-anim') === to.getAttribute('data-anim')
          );
        },
      }
    );
  } catch {
    // Defensive: if a morph ever fails, fall back to a full rebuild so the chat
    // never gets stuck.
    root.innerHTML = renderChatApp(modelToolsView(snapshot), streamMessageId);
  }
  renderedStructureSig = structureSignature(snapshot);
  for (const panel of document.querySelectorAll<HTMLElement>('[data-inline-activity]'))
    selectActivityTab(panel, activityTabs.get(panel.id) ?? 'output');
  syncModelToolsControls();
  syncExtensionUiControls();

  // Robust sent-text-reappears guard: after an optimistic submit-clear we hold
  // `lastSubmittedText`. If ANY re-render (including an authoritative composer
  // reset, or one that arrives while the composer is unfocused) rebuilds the
  // textarea with exactly that submitted text, blank it. Typing resets
  // `lastSubmittedText` to undefined, so a genuine re-type is never blanked.
  if (!rejectedAck && lastSubmittedText !== undefined) {
    const submittedField = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
    if (submittedField && submittedField.value === lastSubmittedText) {
      submittedField.value = '';
    }
  }

  for (const [id, open] of disclosureOpen) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (el) el.open = open;
  }
  for (const id of openMenus) {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (el) el.open = true;
  }
  restoreInspectorFocus(inspectorFocus);
  for (const wrap of Array.from(document.querySelectorAll<HTMLElement>('.mermaid-wrap'))) {
    setMermaidView(wrap, mermaidModes.get(mermaidKey(wrap)) ?? 'preview');
  }
  restoreMermaidDialog();

  const textarea = document.getElementById(COMPOSER_FIELD_ID) as HTMLTextAreaElement | null;
  const transcriptSelection = window.getSelection()?.isCollapsed === false;
  if (
    textarea &&
    composerWasFocused &&
    !authoritativeReset &&
    document.hasFocus() &&
    !transcriptSelection
  ) {
    if (document.activeElement !== textarea) textarea.focus();
    const caret = preservedStart ?? textarea.value.length;
    const caretEnd = preservedEnd ?? caret;
    try {
      textarea.setSelectionRange(caret, caretEnd);
    } catch {
      /* setSelectionRange can throw for some input types; ignore */
    }
  } else if (
    textarea &&
    composerWasFocused &&
    authoritativeReset &&
    document.hasFocus() &&
    !transcriptSelection
  ) {
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
    syncContextualSteer();
    bindOnce(textarea, 'input', () => {
      if (editingComposer) return;
      exitHistory(); // typing leaves history-navigation mode
      editRevision++;
      lastSubmittedText = undefined; // fresh text — stop guarding
      autosizeComposer(textarea);
      syncContextualSteer();
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
    // Files with browser bytes use payload transport so local client files
    // also work when the extension host is remote. Explorer URI-only drops
    // keep the workspace.fs path, including vscode-remote URIs.
    bindOnce(textarea, 'dragover', (event) => {
      event.preventDefault();
      textarea.closest('.composer-dock')?.classList.add('is-drop-target');
    });
    bindOnce(textarea, 'dragleave', () =>
      textarea.closest('.composer-dock')?.classList.remove('is-drop-target')
    );
    bindOnce(textarea, 'drop', (event) => {
      textarea.closest('.composer-dock')?.classList.remove('is-drop-target');
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        for (const file of files) postDroppedFile(file);
        return;
      }
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
      if (!event.isComposing && !event.altKey && (event.metaKey || event.ctrlKey)) {
        const key = event.key.toLowerCase();
        const command =
          key === 'z'
            ? event.shiftKey
              ? 'redo'
              : 'undo'
            : key === 'y' && event.ctrlKey && !event.shiftKey
              ? 'redo'
              : undefined;
        if (command) {
          event.preventDefault();
          event.stopPropagation();
          document.execCommand?.(command);
          return;
        }
      }
      // Handle composer-only thinking before Tab can accept a completion.
      if (event.key === 'Tab' && event.shiftKey) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
          return;
        }
        event.preventDefault();
        if (
          !event.repeat &&
          currentSnapshot?.bindingState === 'current' &&
          !currentSnapshot.switchingSession &&
          (currentSnapshot.connectionState === 'ready' ||
            currentSnapshot.connectionState === 'busy')
        ) {
          vscode.postMessage({ type: 'executeCommand', command: 'piRpc.cycleThinkingLevel' });
        }
        return;
      }
      // A held activation key is not fresh intent, even after consumption
      // releases the composer while model discovery or a picker is still pending.
      // Gate before completions and follow-once mode changes; keep IME and
      // Shift+Enter native behavior, and allow the next nonrepeat chip-only send.
      if (event.key === 'Enter' && event.repeat && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        return;
      }
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
        event.preventDefault();
        const sendButton = document.getElementById(SEND_BUTTON_ID) as HTMLButtonElement | null;
        if (!sendButton || sendButton.disabled) {
          return;
        }
        submitComposer(sendButton.dataset.sendCommand ?? 'prompt');
      }
    });
  }

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

  for (const editor of root.querySelectorAll<HTMLTextAreaElement>('[data-outbox-editor]')) {
    bindOnce(editor, 'compositionstart', () => outboxComposing.add(editor));
    bindOnce(editor, 'compositionend', () => outboxComposing.delete(editor));
    bindOnce(editor, 'keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) event.stopPropagation();
    });
    if (
      outboxEditFocus?.id === editor.closest<HTMLElement>('[data-outbox-id]')?.dataset.outboxId &&
      outboxEditFocus?.key === editor.dataset.outboxEditorKey &&
      document.hasFocus()
    ) {
      outboxEditFocus = undefined;
      editor.focus();
    }
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-outbox-action]')) {
    bindOnce(button, 'click', () => {
      const row = button.closest<HTMLElement>('[data-outbox-id]');
      const section = row?.closest<HTMLElement>('[data-outbox-key]');
      const action = button.dataset.outboxAction;
      const editor = row?.querySelector<HTMLTextAreaElement>('[data-outbox-editor]');
      if (
        !row ||
        !section ||
        !action ||
        (action === 'save' && (!editor || outboxComposing.has(editor)))
      )
        return;
      if (action === 'edit')
        outboxEditFocus = { key: section.dataset.outboxKey!, id: row.dataset.outboxId! };
      vscode.postMessage({
        type: 'outboxAction',
        key: section.dataset.outboxKey,
        id: row.dataset.outboxId,
        revision: Number(row.dataset.outboxRevision),
        action,
        ...(action === 'save' ? { text: editor!.value } : {}),
      });
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

  for (const field of Array.from(
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-ui-field]')
  )) {
    bindOnce(field, 'compositionstart', () => extensionUiComposing.add(field));
    bindOnce(field, 'compositionend', () => extensionUiComposing.delete(field));
    if (field instanceof HTMLInputElement)
      bindOnce(field, 'keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing || extensionUiComposing.has(field)) return;
        event.preventDefault();
        if (event.repeat) return;
        field
          .closest('.approval-card')
          ?.querySelector<HTMLButtonElement>('[data-ui-input-submit]')
          ?.click();
      });
  }
  // Tool approval: Allow/Deny (or option) buttons respond to the pending request.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.approval-btn'))) {
    bindOnce(button, 'click', () => {
      const id = button.getAttribute('data-ui-id');
      const requestKey = button.getAttribute('data-ui-key');
      syncExtensionUiControls();
      const request = currentSnapshot?.approvals?.find(
        (item) => item.id === id && item.requestKey === requestKey
      );
      if (!id || !requestKey || !request || button.disabled) {
        return;
      }
      const confirmed = button.getAttribute('data-ui-confirmed');
      const value = button.getAttribute('data-ui-value');
      const message: {
        type: 'respondUi';
        id: string;
        requestKey: string;
        value?: string;
        confirmed?: boolean;
        cancelled?: boolean;
      } = {
        type: 'respondUi',
        id,
        requestKey,
      };
      if (confirmed !== null) {
        message.confirmed = confirmed === 'true';
      } else if (button.getAttribute('data-ui-cancelled') === 'true') {
        message.cancelled = true;
      } else if (
        button.getAttribute('data-ui-editor-submit') === 'true' ||
        button.getAttribute('data-ui-input-submit') === 'true'
      ) {
        const editor = button
          .closest('.approval-card')
          ?.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-ui-field]');
        if (editor && extensionUiComposing.has(editor)) return;
        message.value = editor?.value ?? '';
      } else if (value !== null) {
        message.value = value;
      }
      if (message.value !== undefined && message.value.length > 160000) {
        const status = button
          .closest('.approval-card')
          ?.querySelector<HTMLElement>('[role="status"]');
        if (status) status.textContent = 'Response must be 160,000 characters or fewer.';
        return;
      }
      if (button.hasAttribute('data-ui-draft-use') && currentSnapshot) {
        extensionUiDraftSubmission = {
          requestKey,
          originKey: commandSessionKey(currentSnapshot),
          generation: currentSnapshot.catalogGeneration,
          frame: request.draftResetSeq!,
          revision: editRevision,
          text: composerField()?.value ?? currentSnapshot.draft,
          attachments: attachmentKey(currentSnapshot),
          pending: true,
        };
      }
      extensionUiPending.add(requestKey);
      syncExtensionUiControls();
      vscode.postMessage(message);
    });
  }

  // #3 — open file / open changes for edit-tool cards.
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-mcp-check]'))) {
    bindOnce(button, 'click', () => {
      button.disabled = true;
      button.textContent = 'Checking…';
      vscode.postMessage({ type: 'checkMcpStatus' });
    });
  }
  bindActivityActions(root);

  bindOnce(document.getElementById(PREVIEW_DIALOG_ID), 'keydown', handlePreviewKeydown);
  bindOnce(document.getElementById(MERMAID_DIALOG_CLOSE_ID), 'click', closeMermaidDialog);
  bindOnce(document.getElementById(MERMAID_DIALOG_ID), 'keydown', handleMermaidDialogKeydown);

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
      const hasRawPayload = button.dataset.copyRaw !== undefined;
      const text =
        button.dataset.copyRaw ??
        article?.querySelector('.tl-answer .tl-body')?.textContent ??
        article?.querySelector('.message-body')?.textContent ??
        article?.querySelector('.tl-body')?.textContent ??
        '';
      if (!text.trim()) {
        return;
      }
      void navigator.clipboard
        ?.writeText(hasRawPayload ? text : text.trim())
        .then(() => {
          button.classList.add('is-copied');
          setTimeout(() => button.classList.remove('is-copied'), 1000);
        })
        .catch(() => undefined);
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

// Host snapshots can coalesce several text deltas, especially over SSH.
// Reveal new live text locally, including a backlog after the backend settles. The streaming
// answer element is marked `.js-stream-text` with the full text in `data-raw`.
let streamTimer: ReturnType<typeof setInterval> | undefined;
let streamRaw = '';
let streamRevealLen = 0;
let streamMessageId: string | undefined;
let streamSpeed: string | undefined;
let streamDeadline = 0;
let streamPaintedNode: HTMLElement | undefined;
let streamPaintedText = '';
function paintStream(node: HTMLElement): void {
  const revealed = streamRaw.slice(0, streamRevealLen);
  if (streamPaintedNode === node && streamPaintedText === revealed) return;
  const diagrams = Array.from(node.querySelectorAll<HTMLElement>('.mermaid-wrap'));
  node.innerHTML = renderRichText(revealed, true);
  Array.from(node.querySelectorAll<HTMLElement>('.mermaid-wrap')).forEach((wrap, index) => {
    const previous = diagrams[index];
    if (
      previous?.dataset.mermaidComplete === 'true' &&
      wrap.dataset.mermaidComplete === 'true' &&
      previous.querySelector('.mermaid-code code')?.textContent ===
        wrap.querySelector('.mermaid-code code')?.textContent
    ) {
      wrap.replaceWith(previous);
      return;
    }
    setMermaidView(wrap, previous?.dataset.mermaidView === 'code' ? 'code' : 'preview');
  });
  bindCodeControls(node);
  streamPaintedNode = node;
  streamPaintedText = revealed;
}
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
          const b = block as {
            kind: string;
            text?: string;
            name?: string;
            args?: string;
            isError?: boolean;
          };
          const isAnswer = b.kind === 'text';
          const textLen = isLast && isAnswer ? '' : String((b.text ?? '').length);
          return `${b.kind}:${b.name ?? ''}:${textLen}:${b.args ?? ''}:${b.isError ? 'E' : ''}`;
        })
        .join(',');
      const textLen = isLast ? '' : String((m.text ?? '').length);
      return `${m.role}:${m.id}:${textLen}:[${blocks}]:tasks${JSON.stringify(m.reportedTasks ?? null)}`;
    })
    .join('#');
  return (
    `${commandSessionKey(s)}|${msgs}|${s.connectionState}|${s.isCompacting ? 1 : 0}|${s.workingAnimation}` +
    `|manualMode${JSON.stringify([s.requireApprovalForEdits, s.approvalModeError])}` +
    `|followMode${s.followMode}` +
    `|q${(s.queue?.steering.length ?? 0) + (s.queue?.followUp.length ?? 0)}` +
    `|a${JSON.stringify(s.approvals?.map((item) => [item.requestKey, item.id, item.method, item.responseState, item.responseError, item.draftRevision, item.draftResetSeq]))}|p${s.pendingContextItems.length}/${s.pendingImages.length}` +
    `|extensionDraftAck${JSON.stringify(s.extensionUiDraftAck ?? null)}` +
    `|reported${JSON.stringify(s.activity?.agents ?? [])}` +
    `|runtimeActivity${JSON.stringify([s.activity?.tools, s.activity?.output, s.activity?.statuses, s.activity?.files])}` +
    `|modelTools${JSON.stringify([s.modelTools?.requestId, s.modelTools?.status, s.modelTools?.revision, s.modelTools?.message])}` +
    `|mcpStatus${JSON.stringify(s.mcpStatus ?? null)}` +
    `|outbox${JSON.stringify([s.outbox?.key, s.outbox?.notice, s.outbox?.readOnly, s.outbox?.items.map((item) => [item.id, item.revision, item.status])])}|outboxAck${JSON.stringify(s.outboxAck ?? null)}`
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
function resetTypewriter(): void {
  stopTypewriter();
  streamPaintedNode = undefined;
  streamPaintedText = '';
  streamMessageId = undefined;
  streamRaw = '';
  streamRevealLen = 0;
}
function prepareTypewriter(snapshot: WebviewSnapshot): void {
  const previous = currentSnapshot;
  const sameSession = commandSessionKey(snapshot) === commandSessionKey(previous);
  if (
    !sameSession ||
    snapshot.switchingSession ||
    snapshot.bindingState === 'cached' ||
    snapshot.bindingState === 'draft'
  )
    resetTypewriter();
  if (snapshot.typewriterSpeed === 'off' || prefersReducedMotion()) {
    resetTypewriter();
    return;
  }
  if (
    snapshot.switchingSession ||
    snapshot.bindingState === 'cached' ||
    snapshot.bindingState === 'draft'
  )
    return;
  const last = snapshot.messages.at(-1);
  if (last?.role === 'user' && last.id !== previous?.messages.at(-1)?.id) resetTypewriter();
  const changedAnswer =
    sameSession &&
    isLiveWorking(previous) &&
    last?.role === 'assistant' &&
    (last.id !== previous?.messages.at(-1)?.id ||
      lastStreamText(snapshot) !== lastStreamText(previous));
  const id = isLiveWorking(snapshot)
    ? snapshot.currentAssistantMessageId
    : changedAnswer
      ? last?.id
      : undefined;
  if (id && id !== streamMessageId) {
    resetTypewriter();
    streamMessageId = id;
  }
  if (streamMessageId && !snapshot.messages.some((message) => message.id === streamMessageId))
    resetTypewriter();
}
function finishSettledReveal(): boolean {
  if (!streamMessageId || !currentSnapshot || isLiveWorking(currentSnapshot)) return false;
  // This local redraw has no authority to overwrite edits awaiting a remote draft echo.
  const snapshot =
    currentSnapshot.composerResetSeq === lastComposerResetSeq
      ? { ...currentSnapshot, draft: composerField()?.value ?? currentSnapshot.draft }
      : currentSnapshot;
  resetTypewriter();
  // Restore settled formatting/recovery controls; render defers safely during inline editing.
  render(snapshot);
  return true;
}
function advanceTypewriter(): void {
  const speed = currentSnapshot?.typewriterSpeed ?? 'normal';
  const el = streamTarget();
  if (!el) {
    if (!finishSettledReveal()) resetTypewriter();
    return;
  }
  const raw = el.getAttribute('data-raw') ?? '';
  if (speed === 'off' || prefersReducedMotion()) {
    streamRaw = raw;
    streamRevealLen = raw.length;
    paintStream(el);
    if (!finishSettledReveal()) resetTypewriter();
    return;
  }
  if (!streamMessageId) return;
  // Corrections may share a long prefix: never retain characters that changed.
  if (!raw.startsWith(streamRaw)) {
    let common = 0;
    while (common < streamRevealLen && common < raw.length && raw[common] === streamRaw[common])
      common++;
    streamRevealLen = common;
  }
  if (streamRaw !== raw || streamSpeed !== speed)
    streamDeadline = performance.now() + (speed === 'slow' ? 4000 : speed === 'fast' ? 1200 : 2400);
  streamRaw = raw;
  paintStream(el);
  if (streamTimer && streamSpeed !== speed) stopTypewriter();
  streamSpeed = speed;
  if (streamRevealLen >= raw.length) {
    stopTypewriter();
    finishSettledReveal();
    return;
  }
  if (!streamTimer && streamRevealLen < raw.length) {
    streamTimer = setInterval(
      () => {
        const node = streamTarget();
        if (!node || workingDisposed) {
          resetTypewriter();
          return;
        }
        const selectedSpeed = currentSnapshot?.typewriterSpeed ?? 'normal';
        const tuning = TYPEWRITER_SPEEDS[selectedSpeed] ?? TYPEWRITER_SPEEDS.normal!;
        const remaining = streamRaw.length - streamRevealLen;
        // Cap ordinary chunks and catch up by the deadline after delayed browser frames.
        const step = Math.max(
          2,
          Math.min(96, Math.ceil(remaining / tuning.divisor)),
          Math.ceil(
            (remaining * tuning.interval) /
              Math.max(tuning.interval, streamDeadline - performance.now())
          )
        );
        streamRevealLen = Math.min(streamRaw.length, streamRevealLen + step);
        paintStream(node);
        keepPinnedToBottom();
        if (streamRevealLen >= streamRaw.length) {
          stopTypewriter();
          finishSettledReveal();
        }
      },
      (TYPEWRITER_SPEEDS[speed] ?? TYPEWRITER_SPEEDS.normal!).interval
    );
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
let workingDisposed = false;
let phraseTimer: ReturnType<typeof setInterval> | undefined;
let workingPhrase = 0;
let workingPhraseSession: string | undefined;
function stopWorkingPhrases(): void {
  if (phraseTimer) clearInterval(phraseTimer);
  phraseTimer = undefined;
  workingPhrase = 0;
  workingPhraseSession = undefined;
}
function updateWorkingPhrase(): void {
  if (workingDisposed || !isLiveWorking(currentSnapshot)) {
    stopWorkingPhrases();
    return;
  }
  const snapshot = currentSnapshot!;
  const session = snapshot.sessionFile ?? snapshot.sessionId ?? 'draft';
  if (workingPhraseSession !== session) {
    stopWorkingPhrases();
    workingPhraseSession = session;
  }
  const label = document.querySelector('.working-label');
  if (!label) {
    stopWorkingPhrases();
    return;
  }
  const text = workingLabel(snapshot, workingPhrase);
  if (label.textContent !== text) label.textContent = text;
  if (
    prefersReducedMotion() ||
    snapshot.isCompacting ||
    snapshot.approvals?.some(isBlockingExtensionUi)
  ) {
    if (phraseTimer) clearInterval(phraseTimer);
    phraseTimer = undefined;
  } else if (!phraseTimer) {
    phraseTimer = setInterval(() => {
      workingPhrase = (workingPhrase + 1) % WORKING_PHRASES.length;
      updateWorkingPhrase();
    }, 6000);
  }
}
const workingMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function motionChanged(): void {
  startWorkingAnimation();
  advanceTypewriter();
}
workingMotion.addEventListener('change', motionChanged);
const workingClassObserver = new MutationObserver(motionChanged);
workingClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
function stopWorkingAnimation(): void {
  if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = undefined;
  }
}
function startWorkingAnimation(): void {
  updateWorkingPhrase();
  const container = document.querySelector('.working');
  if (workingDisposed || !isLiveWorking(currentSnapshot) || !container) {
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
      const frame = frames[prefersReducedMotion() ? 0 : workingFrame % frames.length] ?? '';
      if (glyph.textContent !== frame) glyph.textContent = frame;
    }
  };
  paint();
  if (prefersReducedMotion()) {
    stopWorkingAnimation();
    return;
  }
  if (!workingTimer) {
    workingTimer = setInterval(() => {
      if (
        workingDisposed ||
        !isLiveWorking(currentSnapshot) ||
        !document.querySelector('.working')
      ) {
        stopWorkingAnimation();
        return;
      }
      workingFrame = (workingFrame + 1) % 1_000_000;
      startWorkingAnimation();
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
  if (!currentSnapshot.preview && window.getSelection()?.isCollapsed === false) return;
  if (!currentSnapshot.preview && document.activeElement?.closest('[data-outbox-id]')) return;
  if (!currentSnapshot.preview && document.activeElement?.closest('[data-model-tools]')) return;
  if (!currentSnapshot.preview && document.activeElement?.closest('.approval-card')) return;
  const targetId = focusTargetFromSnapshot(currentSnapshot);
  const request = targetId
    ? JSON.stringify([commandSessionKey(currentSnapshot), targetId])
    : undefined;
  if (
    !currentSnapshot.preview &&
    document.activeElement?.closest('[data-inline-activity], #chat-settings') &&
    (!targetId || request === appliedFocusRequest)
  ) {
    appliedFocusRequest = request;
    return;
  }
  // Opening reported work is an explicit focus choice, including before the first passive focus ack.
  if (
    !currentSnapshot.preview &&
    currentSnapshot.focus === 'composer' &&
    document.activeElement?.closest('.reported-agent')
  ) {
    appliedFocusRequest = request;
    return;
  }
  if (request === appliedFocusRequest) return;
  appliedFocusRequest = request;
  if (focusElement(targetId)) {
    if (shouldClearSnapshotFocus(currentSnapshot.focus)) {
      vscode.postMessage({ type: 'setFocus', focus: 'none' });
    }
    return;
  }
  if (focusElement(PREVIEW_DIALOG_ID)) {
    return;
  }
}

window.addEventListener('beforeunload', () => {
  persistViewState();
  workingDisposed = true;
  stopWorkingPhrases();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  pendingSnapshot = undefined;
  deferredSnapshot = undefined;
  stopWorkingAnimation();
  resetTypewriter();
  workingMotion.removeEventListener('change', motionChanged);
  workingClassObserver.disconnect();
});

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
    if (event.data?.type === 'find') {
      openFind();
      return;
    }
    if (event.data?.type === 'screenRevertResult') {
      const result = event.data as unknown as { callId: string; success: boolean };
      for (const span of Array.from(root?.querySelectorAll<HTMLElement>('.edit-approve') ?? [])) {
        if (span.dataset.ecid !== result.callId) continue;
        if (result.success) {
          span.classList.add('is-decided');
          span.innerHTML = '<span class="ed-done">↩ undone</span>';
        } else {
          const button = span.querySelector<HTMLButtonElement>('.ed-undo');
          if (button) {
            button.disabled = false;
            button.textContent = '↩ Undo';
          }
        }
      }
      return;
    }
    if (event.data?.type === 'snapshot') {
      const snapshot = event.data.snapshot as WebviewSnapshot;
      const context = `${commandSessionKey(snapshot)}:${snapshot.bindingState}:${snapshot.catalogGeneration}:${['ready', 'busy'].includes(snapshot.connectionState)}`;
      if (slashContext !== undefined && slashContext !== context) {
        slashCommands = localSlashCommands();
        slashRequested = false;
        slashRequestId = undefined;
        slashAttempts = 0;
        slashComplete = false;
      }
      slashContext = context;
      render(snapshot);
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
        requestId?: string;
        complete?: boolean;
      };
      if (payload.requestId !== undefined && payload.requestId !== slashRequestId) return;
      slashCommands = mergeLocalCommands(Array.isArray(payload.items) ? payload.items : []).map(
        (item) => ({ name: item.name as string, description: item.description as string })
      );
      slashComplete = payload.complete !== false;
      if (!slashComplete) slashRetryAfter = Date.now() + 1000;
      // Do not retry from the reply callback: only subsequent input/readiness events.
      // Keep this request latched while painting so one failed reply cannot loop.
      updateSlashMenu();
      slashRequested = false;
    }
  }
);
