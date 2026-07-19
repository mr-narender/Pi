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
      <div class="empty-state-card">
        <p class="empty-title">No messages yet.</p>
        <p class="empty-copy">Start a new chat, resume a saved chat, or type below.</p>
        <div class="button-row compact">
          <button type="button" data-command="piRpc.newSession">New Chat</button>
          <button type="button" data-command="piRpc.switchSession">Resume Chat</button>
        </div>
        <button type="button" class="link-button" data-command="piRpcInternal.showHelp">Help</button>
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
        <p class="muted" id="${PREVIEW_DESCRIPTION_ID}">This is the exact Pi RPC payload that will be sent.</p>
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

function renderAdvanced(snapshot: WebviewSnapshot): string {
  if (snapshot.uiMode !== 'advanced') {
    return '';
  }
  const groups: Array<{ title: string; commands: Array<[string, string]> }> = [
    {
      title: 'Session',
      commands: [
        ['piRpcInternal.start', 'Start Pi'],
        ['piRpcInternal.stop', 'Stop Pi'],
        ['piRpcInternal.restart', 'Restart Pi'],
        ['piRpc.refreshState', 'Refresh state'],
        ['piRpc.refreshMessages', 'Refresh messages'],
        ['piRpc.renameSession', 'Rename chat'],
      ],
    },
    {
      title: 'Branches',
      commands: [
        ['piRpc.forkSession', 'Start branch'],
        ['piRpc.cloneSession', 'Duplicate path'],
        ['piRpc.showForkMessages', 'Branch starting points'],
        ['piRpc.refreshEntries', 'Refresh branches'],
        ['piRpc.showSessionTree', 'Conversation map'],
        ['piRpc.copyLastAssistant', 'Copy last assistant'],
      ],
    },
    {
      title: 'Queue & steering',
      commands: [
        ['piRpc.steer', 'Steer'],
        ['piRpc.followUp', 'Follow-up'],
        ['piRpc.setSteeringMode', 'Steering mode'],
        ['piRpc.setFollowUpMode', 'Follow-up mode'],
        ['piRpc.toggleAutoRetry', 'Auto retry'],
        ['piRpc.abortRetry', 'Abort retry'],
      ],
    },
    {
      title: 'Model & thinking',
      commands: [
        ['piRpc.showModels', 'Choose model'],
        ['piRpc.cycleModel', 'Cycle model'],
        ['piRpc.setThinkingLevel', 'Thinking level'],
        ['piRpc.cycleThinkingLevel', 'Cycle thinking'],
      ],
    },
    {
      title: 'Commands & tools',
      commands: [
        ['piRpc.showPiCommands', 'Pi commands'],
        ['piRpc.compact', 'Compact conversation'],
        ['piRpc.toggleAutoCompaction', 'Auto compaction'],
        ['piRpc.runBash', 'Run bash'],
        ['piRpc.abortBash', 'Abort bash'],
      ],
    },
    {
      title: 'Stats & export',
      commands: [
        ['piRpc.showSessionStats', 'Session stats'],
        ['piRpc.exportHtml', 'Export HTML'],
      ],
    },
    {
      title: 'Diagnostics',
      commands: [
        ['piRpc.inspectRpcError', 'RPC errors'],
        ['piRpc.inspectParseError', 'Parse errors'],
        ['piRpc.inspectExtensionError', 'Extension errors'],
        ['piRpc.inspectCompatibilityEvents', 'Compatibility events'],
        ['piRpcInternal.showHealth', 'Health'],
        ['piRpcInternal.exportDiagnostics', 'Export diagnostics'],
      ],
    },
    {
      title: 'Developer tools',
      commands: [
        ['piRpc.respondExtensionUi', 'Inspect responses'],
        ['piRpc.extensionUi.select', 'Select dialog'],
        ['piRpc.extensionUi.confirm', 'Confirm dialog'],
        ['piRpc.extensionUi.input', 'Input dialog'],
        ['piRpc.extensionUi.editor', 'Editor dialog'],
        ['piRpc.extensionUi.notify', 'Notify'],
        ['piRpc.extensionUi.setTitle', 'Set title'],
        ['piRpc.extensionUi.setEditorText', 'Set draft'],
        ['piRpc.extensionUiLocal.custom', 'Local UI custom'],
      ],
    },
  ];
  return `
    <section class="advanced-panel" aria-labelledby="advanced-heading">
      <div class="section-heading-row">
        <h2 id="advanced-heading">Advanced</h2>
        <button type="button" data-command="piRpc.toggleAdvancedMode">Hide Advanced</button>
      </div>
      ${groups
        .map(
          (group) => `
            <details class="advanced-group" open>
              <summary>${escapeHtml(group.title)}</summary>
              <div class="button-grid">
                ${group.commands
                  .map(
                    ([command, label]) =>
                      `<button type="button" data-command="${escapeHtml(command)}">${escapeHtml(label)}</button>`
                  )
                  .join('')}
              </div>
            </details>`
        )
        .join('')}
    </section>`;
}

function renderMoreMenu(snapshot: WebviewSnapshot): string {
  return `
    <details class="menu-details" id="more-menu">
      <summary>More</summary>
      <div class="menu-panel">
        <button type="button" data-command="piRpc.toggleAdvancedMode">${snapshot.uiMode === 'advanced' ? 'Simple mode' : 'Advanced'}</button>
        <button type="button" data-command="piRpcInternal.restart">Restart Pi</button>
        <button type="button" data-command="piRpcInternal.showHelp">Help</button>
      </div>
    </details>`;
}

export function renderChatApp(snapshot: WebviewSnapshot): string {
  const busy = snapshot.isStreaming || snapshot.connectionState === 'busy';
  const sendLabel = busy ? 'Send next' : 'Send';
  const sendCommand = busy ? 'follow_up' : 'prompt';
  const summaryLine = `${snapshot.workspaceFolderName} · ${sessionLabel(snapshot)} · ${statusLabel(snapshot)}`;
  const attachmentsVisible =
    snapshot.pendingContextItems.length > 0 || snapshot.pendingImages.length > 0;
  const restrictedBanner = snapshot.isTrusted
    ? ''
    : `<section class="banner info"><strong>Restricted Mode</strong><div class="muted">Restricted Mode: chat can read, but changes stay disabled until you trust this workspace.</div></section>`;

  return `
    <a class="skip-link" href="#composer-field">Skip to composer</a>
    <div class="layout" data-testid="chat-app" data-ui-mode="${escapeHtml(snapshot.uiMode)}">
      <header class="chat-header" role="banner">
        <div class="header-main">
          <h1>Current Chat</h1>
          <div class="header-summary" aria-label="Current chat summary">${escapeHtml(summaryLine)}</div>
        </div>
        <div class="header-controls">
          <button type="button" data-command="piRpc.showModels">${escapeHtml(modelLabel(snapshot))}</button>
          <button type="button" data-command="piRpc.newSession">New</button>
          <button type="button" data-command="piRpc.switchSession">Resume</button>
          ${renderMoreMenu(snapshot)}
        </div>
      </header>

      ${restrictedBanner}
      ${renderRecovery(snapshot)}

      <section class="transcript-panel">
        <div class="section-heading-row">
          <h2>Transcript</h2>
          ${
            snapshot.folders.length > 1
              ? `<label class="inline-select"><span>Workspace</span><select id="folder-select" aria-label="Choose workspace">${snapshot.folders
                  .map(
                    (folder) =>
                      `<option value="${escapeHtml(folder.uri)}" ${folder.active ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`
                  )
                  .join('')}</select></label>`
              : ''
          }
        </div>
        <div id="messages" role="log" aria-live="polite" aria-relevant="additions text">${renderMessages(snapshot)}</div>
      </section>

      <section class="composer-panel" aria-labelledby="composer-heading">
        <h2 id="composer-heading">Message Pi</h2>
        <label class="composer-label" for="${COMPOSER_FIELD_ID}">Message Pi</label>
        <textarea id="${COMPOSER_FIELD_ID}" rows="6">${escapeHtml(snapshot.draft)}</textarea>
        ${
          attachmentsVisible
            ? `<div class="attachment-tray"><div class="section-label">Attachments for next message</div><div class="chip-list" role="list" aria-label="Attachments for next message">${snapshot.pendingContextItems
                .map((item) => renderContextChip(item))
                .join(
                  ''
                )}${renderImageChip(snapshot)}</div><button type="button" data-action="clearAttachments">Clear attachments</button></div>`
            : ''
        }
        <div class="button-row" aria-label="Composer actions">
          <details class="menu-details" id="attach-menu">
            <summary id="attach-trigger">Attach</summary>
            <div class="menu-panel">
              <button type="button" data-action="pickImages">Image…</button>
              <button type="button" data-action="appendActiveFile">Active file</button>
              <button type="button" data-action="appendPickedFile">Pick file…</button>
              <button type="button" data-action="appendSelection">Current selection</button>
              <button type="button" data-action="appendDiagnostics">Diagnostics</button>
              ${attachmentsVisible ? '<button type="button" data-action="clearAttachments">Clear attachments</button>' : ''}
            </div>
          </details>
          <button type="button" id="${SEND_BUTTON_ID}" data-send-command="${sendCommand}">${sendLabel}</button>
          ${busy ? '<button type="button" data-action="abort">Stop</button>' : ''}
        </div>
      </section>

      ${renderAdvanced(snapshot)}
      ${renderPreview(snapshot)}
    </div>`;
}
