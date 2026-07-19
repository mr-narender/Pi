import type { WebviewSnapshot } from '../state/types';
import { chipPrivacyLabel, summarizeChip, type PendingContextItem } from './composer';

export const COMPOSER_FIELD_ID = 'composer-field';
export const ATTACH_TRIGGER_ID = 'attach-trigger';
export const SEND_BUTTON_ID = 'composer-send-button';
export const PREVIEW_DIALOG_ID = 'preview-panel';
export const PREVIEW_TITLE_ID = 'preview-title';
export const PREVIEW_DESCRIPTION_ID = 'preview-description';
export const PREVIEW_ACCEPT_BUTTON_ID = 'preview-accept-button';
export const PREVIEW_CANCEL_BUTTON_ID = 'preview-cancel-button';

export function contextChipRemoveButtonId(itemId: string): string {
  return `context-chip-remove-${itemId}`;
}

export function imageChipRemoveButtonId(itemId: string): string {
  return `image-chip-remove-${itemId}`;
}

export function focusTargetFromSnapshot(
  snapshot: Pick<WebviewSnapshot, 'focus' | 'preview' | 'pendingContextItems' | 'pendingImages'>
): string | undefined {
  if (snapshot.preview || snapshot.focus === 'preview') {
    return PREVIEW_ACCEPT_BUTTON_ID;
  }
  if (snapshot.focus === 'attach') {
    return ATTACH_TRIGGER_ID;
  }
  if (snapshot.focus === 'contextChip') {
    const item = snapshot.pendingContextItems.at(-1);
    return item ? contextChipRemoveButtonId(item.itemId) : ATTACH_TRIGGER_ID;
  }
  if (snapshot.focus === 'imageChip') {
    const item = snapshot.pendingImages.at(-1);
    return item ? imageChipRemoveButtonId(item.itemId) : ATTACH_TRIGGER_ID;
  }
  if (snapshot.focus === 'none') {
    return undefined;
  }
  return COMPOSER_FIELD_ID;
}

export function planChipRemovalFocus(
  snapshot: Pick<WebviewSnapshot, 'pendingContextItems' | 'pendingImages'>,
  itemId: string
): { targetId?: string; fallbackId: string } {
  const removeButtonIds = [
    ...snapshot.pendingContextItems.map((item) => contextChipRemoveButtonId(item.itemId)),
    ...snapshot.pendingImages.map((item) => imageChipRemoveButtonId(item.itemId)),
  ];
  const currentIndex = [contextChipRemoveButtonId(itemId), imageChipRemoveButtonId(itemId)].reduce(
    (match, buttonId) => (match >= 0 ? match : removeButtonIds.indexOf(buttonId)),
    -1
  );
  if (currentIndex >= 0 && currentIndex + 1 < removeButtonIds.length) {
    return { targetId: removeButtonIds[currentIndex + 1], fallbackId: ATTACH_TRIGGER_ID };
  }
  if (currentIndex > 0) {
    return { targetId: removeButtonIds[currentIndex - 1], fallbackId: ATTACH_TRIGGER_ID };
  }
  return { fallbackId: ATTACH_TRIGGER_ID };
}

export function nextPreviewTrapTarget(currentId: string | undefined, backwards = false): string {
  const actionIds: readonly [string, string] = [PREVIEW_ACCEPT_BUTTON_ID, PREVIEW_CANCEL_BUTTON_ID];
  const index = currentId ? actionIds.indexOf(currentId) : -1;
  const nextIndex =
    index < 0
      ? backwards
        ? 1
        : 0
      : (index + (backwards ? actionIds.length - 1 : 1)) % actionIds.length;
  return nextIndex === 0 ? actionIds[0] : actionIds[1];
}

export function shouldClearSnapshotFocus(
  focus: WebviewSnapshot['focus']
): focus is 'contextChip' | 'imageChip' | 'preview' {
  return focus === 'contextChip' || focus === 'imageChip' || focus === 'preview';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sessionLabel(snapshot: WebviewSnapshot): string {
  return snapshot.sessionName ?? snapshot.sessionId ?? snapshot.sessionFile ?? 'No chat yet';
}

function modelLabel(snapshot: WebviewSnapshot): string {
  return snapshot.model?.provider && snapshot.model?.id
    ? `${snapshot.model.provider}/${snapshot.model.id}`
    : 'Model';
}

function statusLabel(snapshot: WebviewSnapshot): string {
  if (snapshot.isStreaming) {
    return 'Pi is replying';
  }
  if (snapshot.isCompacting) {
    return 'Compacting';
  }
  if (snapshot.connectionState === 'faulted') {
    return 'Needs attention';
  }
  if (snapshot.connectionState === 'starting' || snapshot.connectionState === 'handshaking') {
    return 'Starting';
  }
  if (snapshot.connectionState === 'stopped') {
    return 'Ready to start';
  }
  return 'Ready';
}

function renderAttachment(
  attachment: WebviewSnapshot['messages'][number]['attachments'][number]
): string {
  const bits = [
    attachment.name,
    attachment.mimeType,
    attachment.size !== undefined ? `${attachment.size}b` : undefined,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => `<span class="meta-pill">${escapeHtml(value)}</span>`)
    .join('');
  return `
    <details class="message-attachment">
      <summary>${escapeHtml(attachment.type)}${attachment.name ? ` · ${escapeHtml(attachment.name)}` : ''}</summary>
      <div class="detail-stack">
        <div>${bits}</div>
        ${attachment.extractedText ? `<pre>${escapeHtml(attachment.extractedText)}</pre>` : ''}
        ${attachment.previewItems
          .map(
            (item) =>
              `<div><strong>${escapeHtml(item.key)}:</strong> ${escapeHtml(item.value)}</div>`
          )
          .join('')}
        ${attachment.fileRef ? `<button type="button" data-attachment-uri="${escapeHtml(attachment.fileRef.uri)}">Open ${escapeHtml(attachment.fileRef.path)}</button>` : ''}
      </div>
    </details>`;
}

function renderMessages(snapshot: WebviewSnapshot): string {
  if (snapshot.messages.length === 0) {
    return `
      <div class="empty-state" data-testid="empty-state">
        <svg class="empty-mascot" width="64" height="48" viewBox="0 0 8 6" role="img" aria-label="Pi" shape-rendering="crispEdges">
          <rect x="1" y="1" width="6" height="4" fill="currentColor" />
          <rect x="2" y="2" width="1" height="1" fill="var(--vscode-editor-background)" />
          <rect x="5" y="2" width="1" height="1" fill="var(--vscode-editor-background)" />
          <rect x="1" y="5" width="1" height="1" fill="currentColor" />
          <rect x="3" y="5" width="1" height="1" fill="currentColor" />
          <rect x="6" y="5" width="1" height="1" fill="currentColor" />
        </svg>
        <p class="empty-copy">What to do first? Ask about this codebase or start writing code.</p>
      </div>`;
  }
  return snapshot.messages
    .map(
      (message) => `
        <article class="message-card message-${escapeHtml(message.role)}">
          <div class="message-role">${escapeHtml(message.role === 'assistant' ? 'Pi' : message.role === 'user' ? 'You' : message.role)}</div>
          <pre>${escapeHtml(message.text)}</pre>
          ${message.attachments.length > 0 ? `<div class="detail-stack">${message.attachments.map((attachment) => renderAttachment(attachment)).join('')}</div>` : ''}
        </article>`
    )
    .join('');
}

function renderContextChip(item: PendingContextItem): string {
  const stale = item.stale ? ' chip-stale' : '';
  const meta =
    item.kind === 'diagnostics'
      ? `${item.workspaceRelativePath} · ${item.issueCount} issues`
      : `${item.workspaceRelativePath} · L${item.lineStart}-${item.lineEnd}`;
  return `
    <div class="chip-shell" role="listitem" data-chip-id="${escapeHtml(item.itemId)}" data-chip-kind="context">
      <details class="chip-details${stale}">
        <summary>${escapeHtml(summarizeChip(item))}</summary>
        <div class="detail-stack">
          <div class="muted">${escapeHtml(meta)}</div>
          <div class="muted">${escapeHtml(chipPrivacyLabel(item))}</div>
          ${item.stale ? `<div class="warning-text">Expired${item.staleReason ? ` · ${escapeHtml(item.staleReason)}` : ''}</div>` : ''}
          <pre>${escapeHtml(item.sanitizedContent)}</pre>
        </div>
      </details>
      <button
        type="button"
        class="chip-remove-button"
        id="${escapeHtml(contextChipRemoveButtonId(item.itemId))}"
        data-chip-remove-id="${escapeHtml(item.itemId)}"
        data-remove-context="${escapeHtml(item.itemId)}"
        aria-label="Remove ${escapeHtml(summarizeChip(item))}"
        title="Remove"
      >×</button>
    </div>`;
}

function renderImageChip(snapshot: WebviewSnapshot): string {
  return snapshot.pendingImages
    .map(
      (item) => `
        <div class="chip-shell" role="listitem" data-chip-id="${escapeHtml(item.itemId)}" data-chip-kind="image">
          <details class="chip-details${item.requiresReselect ? ' chip-stale' : ''}">
            <summary>${escapeHtml(item.requiresReselect ? `Reselect image: ${item.name}` : `Image: ${item.name}`)}</summary>
            <div class="detail-stack">
              <div class="muted">${escapeHtml(item.mimeType)} · ${item.sizeBytes} bytes</div>
              <div class="muted">Local image · sent on next message only</div>
              ${item.previewDataUrl && !item.requiresReselect ? `<img class="image-preview" src="${escapeHtml(item.previewDataUrl)}" alt="Preview of ${escapeHtml(item.name)}" />` : ''}
              ${item.requiresReselect ? `<div class="warning-text">Expired image selection</div>` : ''}
            </div>
          </details>
          <button
            type="button"
            class="chip-remove-button"
            id="${escapeHtml(imageChipRemoveButtonId(item.itemId))}"
            data-chip-remove-id="${escapeHtml(item.itemId)}"
            data-remove-image="${escapeHtml(item.itemId)}"
            aria-label="Remove image ${escapeHtml(item.name)}"
            title="Remove"
          >×</button>
        </div>`
    )
    .join('');
}

function renderRecovery(snapshot: WebviewSnapshot): string {
  if (!snapshot.recovery) {
    return '';
  }
  const isSendFailure = snapshot.recovery.kind === 'sendFailure';
  return `
    <section class="banner ${snapshot.recovery.kind}">
      <div>
        <strong>${escapeHtml(snapshot.recovery.title)}</strong>
        <div class="muted">${escapeHtml(snapshot.recovery.detail)}</div>
      </div>
      <div class="button-row compact">
        ${snapshot.recovery.kind === 'startFailure' ? '<button type="button" data-command="piRpcInternal.start">Start again</button>' : ''}
        ${snapshot.recovery.kind === 'disconnected' ? '<button type="button" data-command="piRpcInternal.restart">Restart Pi</button><button type="button" data-command="piRpc.switchSession">Resume another chat</button>' : ''}
        ${snapshot.recovery.kind === 'disconnected' ? '<button type="button" data-command="piRpc.toggleAdvancedMode">Show details</button>' : ''}
        ${isSendFailure ? '<button type="button" data-action="copyAcceptedSnapshot">Copy to composer</button><button type="button" data-action="sendAcceptedSnapshotAgain">Send again</button>' : ''}
      </div>
    </section>`;
}

function renderPreview(snapshot: WebviewSnapshot): string {
  if (!snapshot.preview) {
    return '';
  }
  return `
    <section class="modal-backdrop">
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="${PREVIEW_TITLE_ID}"
        aria-describedby="${PREVIEW_DESCRIPTION_ID}"
        id="${PREVIEW_DIALOG_ID}"
        tabindex="-1"
      >
        <h2 id="${PREVIEW_TITLE_ID}">Preview before send</h2>
        <p class="muted" id="${PREVIEW_DESCRIPTION_ID}">This is the exact Pi payload that will be sent.</p>
        <div class="detail-stack">
          <div><strong>Command:</strong> ${escapeHtml(snapshot.preview.command)}</div>
          <div><strong>Images:</strong> ${snapshot.preview.imageItems.length}</div>
          <pre>${escapeHtml(snapshot.preview.rpcMessage)}</pre>
        </div>
        ${
          snapshot.preview.imageItems.length > 0
            ? `<div class="detail-stack">${snapshot.preview.imageItems
                .map(
                  (item) =>
                    `<div class="meta-row"><span>${escapeHtml(item.name)}</span><span class="muted">${escapeHtml(item.mimeType)} · ${item.sizeBytes} bytes</span></div>`
                )
                .join('')}</div>`
            : ''
        }
        <div class="button-row">
          <button type="button" id="${PREVIEW_ACCEPT_BUTTON_ID}" data-action="acceptPreview">Send</button>
          <button type="button" id="${PREVIEW_CANCEL_BUTTON_ID}" data-action="cancelPreview">Cancel</button>
        </div>
      </div>
    </section>`;
}

function renderMoreMenu(_snapshot: WebviewSnapshot): string {
  return `
    <details class="menu-details more-menu" id="more-menu">
      <summary aria-label="More actions">More ▾</summary>
      <div class="menu-panel" role="menu">
        <div class="menu-group">Session</div>
        <button type="button" class="menu-item cat-session" data-command="piRpc.renameSession"><span class="dot"></span>Rename chat</button>
        <button type="button" class="menu-item cat-session" data-command="piRpc.exportHtml"><span class="dot"></span>Export as HTML</button>
        <div class="menu-group">Model</div>
        <button type="button" class="menu-item cat-model" data-command="piRpc.showModels"><span class="dot"></span>Choose model</button>
        <button type="button" class="menu-item cat-model" data-command="piRpc.setThinkingLevel"><span class="dot"></span>Thinking level</button>
        <div class="menu-group">Context</div>
        <button type="button" class="menu-item cat-context" data-command="piRpc.compact"><span class="dot"></span>Compact conversation</button>
        <button type="button" class="menu-item cat-context" data-command="piRpc.showSessionStats"><span class="dot"></span>Usage &amp; cost</button>
        <div class="menu-group">System</div>
        <button type="button" class="menu-item cat-system" data-command="piRpcInternal.restart"><span class="dot"></span>Restart Pi</button>
        <button type="button" class="menu-item cat-system" data-command="piRpcInternal.showHealth"><span class="dot"></span>Connection health</button>
        <button type="button" class="menu-item cat-system" data-command="piRpcInternal.showHelp"><span class="dot"></span>Help</button>
      </div>
    </details>`;
}

export function renderChatApp(snapshot: WebviewSnapshot): string {
  const busy = snapshot.isStreaming || snapshot.connectionState === 'busy';
  const interactive = snapshot.connectionState === 'ready' || snapshot.connectionState === 'busy';
  const faulted = snapshot.connectionState === 'faulted';
  const connecting = !interactive && !faulted;
  const disabledAttr = interactive ? '' : 'disabled';
  const sendLabel = busy ? 'Send next' : 'Send';
  const sendCommand = busy ? 'follow_up' : 'prompt';
  const bindingLabel =
    snapshot.bindingState === 'cached'
      ? 'Cached'
      : snapshot.bindingState === 'draft'
        ? 'New draft'
        : 'Current';
  const summaryLine = `${bindingLabel} · ${snapshot.workspaceFolderName} · ${sessionLabel(snapshot)} · ${statusLabel(snapshot)}`;
  const attachmentsVisible =
    snapshot.pendingContextItems.length > 0 || snapshot.pendingImages.length > 0;
  const restrictedBanner = snapshot.isTrusted
    ? ''
    : `<section class="banner info"><strong>Restricted Mode</strong><div class="muted">Restricted Mode: chat can read, but changes stay disabled until you trust this workspace.</div></section>`;

  const folderSelect =
    snapshot.folders.length > 1
      ? `<label class="inline-select"><span class="visually-hidden">Workspace</span><select id="folder-select" aria-label="Choose workspace">${snapshot.folders
          .map(
            (folder) =>
              `<option value="${escapeHtml(folder.uri)}" ${folder.active ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`
          )
          .join('')}</select></label>`
      : '';

  return `
    <a class="skip-link" href="#composer-field">Skip to composer</a>
    <div class="layout" data-testid="chat-app" data-ui-mode="${escapeHtml(snapshot.uiMode)}">
      <header class="brand-bar" role="banner">
        <div class="brand" aria-label="Pi"><span class="brand-mark" aria-hidden="true">✻</span> Pi</div>
        <div class="brand-controls">
          ${folderSelect}
          <button type="button" class="model-chip" data-command="piRpc.showModels" title="Choose model"><span class="model-dot"></span>${escapeHtml(modelLabel(snapshot))}</button>
          ${renderMoreMenu(snapshot)}
        </div>
      </header>
      <div class="header-summary visually-hidden" aria-label="Current chat summary">${escapeHtml(summaryLine)}</div>

      ${restrictedBanner}
      ${renderRecovery(snapshot)}

      <main class="conversation" id="messages" role="log" aria-live="polite" aria-relevant="additions text">${
        connecting && snapshot.messages.length === 0
          ? `<div class="connecting-state" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><p class="empty-copy">Connecting to Pi…</p></div>`
          : faulted && snapshot.messages.length === 0
            ? `<div class="empty-state"><p class="empty-copy">Couldn’t start Pi for this workspace.</p><button type="button" data-command="piRpcInternal.restart">Try again</button></div>`
            : renderMessages(snapshot)
      }</main>

      <section class="composer-dock" aria-labelledby="composer-heading">
        <h2 id="composer-heading" class="visually-hidden">Message Pi</h2>
        <label class="visually-hidden" for="${COMPOSER_FIELD_ID}">Message Pi</label>
        ${
          attachmentsVisible
            ? `<div class="attachment-tray"><div class="section-label">Attachments for next message</div><div class="chip-list" role="list" aria-label="Attachments for next message">${snapshot.pendingContextItems
                .map((item) => renderContextChip(item))
                .join(
                  ''
                )}${renderImageChip(snapshot)}</div><button type="button" data-action="clearAttachments">Clear attachments</button></div>`
            : ''
        }
        <div class="composer-card${connecting ? ' is-connecting' : ''}" aria-busy="${connecting ? 'true' : 'false'}">
          <textarea id="${COMPOSER_FIELD_ID}" rows="3" placeholder="${connecting ? 'Connecting to Pi…' : 'Ask Pi to edit…'}" ${disabledAttr}>${escapeHtml(snapshot.draft)}</textarea>
          <div class="composer-actions" aria-label="Composer actions">
            <div class="composer-actions-left">
              <details class="menu-details" id="attach-menu"${interactive ? '' : ' aria-disabled="true"'}>
                <summary id="attach-trigger" class="icon-button" title="Attach" aria-label="Attach">+</summary>
                <div class="menu-panel">
                  <button type="button" data-action="pickImages">Image…</button>
                  <button type="button" data-action="appendActiveFile">Active file</button>
                  <button type="button" data-action="appendPickedFile">Pick file…</button>
                  <button type="button" data-action="appendSelection">Current selection</button>
                  <button type="button" data-action="appendDiagnostics">Diagnostics</button>
                  ${attachmentsVisible ? '<button type="button" data-action="clearAttachments">Clear attachments</button>' : ''}
                </div>
              </details>
              <button type="button" class="icon-button" data-command="piRpc.showPiCommands" title="Commands" aria-label="Commands" ${disabledAttr}>/</button>
            </div>
            <div class="composer-actions-right">
              ${busy ? '<button type="button" class="ghost" data-action="abort">Stop</button>' : ''}
              <button type="button" id="${SEND_BUTTON_ID}" class="send-button" data-send-command="${sendCommand}" title="${sendLabel}" aria-label="${sendLabel}" ${disabledAttr}>↑</button>
            </div>
          </div>
        </div>
      </section>

      ${renderPreview(snapshot)}
    </div>`;
}
