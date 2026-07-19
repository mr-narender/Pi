import type { WebviewSnapshot } from '../state/types';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
    .map((value) => `<span class="pill">${escapeHtml(value)}</span>`)
    .join('');
  const preview =
    attachment.previewItems.length > 0
      ? `<div class="attachment-preview">${attachment.previewItems
          .map(
            (item) =>
              `<div><strong>${escapeHtml(item.key)}:</strong> ${escapeHtml(item.value)}</div>`
          )
          .join('')}</div>`
      : '';
  return `
    <div class="attachment-card">
      <div class="attachment-header">
        <strong>${escapeHtml(attachment.type)}</strong>
        ${attachment.id ? `<span class="muted">${escapeHtml(attachment.id)}</span>` : ''}
      </div>
      <div>${bits || '<span class="muted">No attachment metadata</span>'}</div>
      ${attachment.hasContent ? '<div class="muted">Embedded content present (hidden)</div>' : ''}
      ${attachment.extractedText ? `<pre>${escapeHtml(attachment.extractedText)}</pre>` : ''}
      ${preview}
      ${attachment.fileRef ? `<button type="button" data-attachment-uri="${escapeHtml(attachment.fileRef.uri)}" aria-label="Open attachment ${escapeHtml(attachment.fileRef.path)}">Open ${escapeHtml(attachment.fileRef.path)}</button>` : ''}
    </div>`;
}

function renderAttachments(
  attachments: WebviewSnapshot['messages'][number]['attachments']
): string {
  if (attachments.length === 0) {
    return '';
  }
  return `<div class="attachment-strip">${attachments
    .map((attachment) => renderAttachment(attachment))
    .join('')}</div>`;
}

function renderWidgets(widgets: WebviewSnapshot['widgets']): string {
  if (widgets.length === 0) {
    return '<div class="muted">None</div>';
  }
  return widgets
    .map(
      (widget) =>
        `<div class="widget"><strong>${escapeHtml(widget.key)}</strong><pre>${escapeHtml(widget.lines.join('\n'))}</pre></div>`
    )
    .join('');
}

function connectionSummary(snapshot: WebviewSnapshot): string {
  if (snapshot.isStreaming) {
    return 'Streaming reply';
  }
  if (snapshot.isCompacting) {
    return 'Compacting context';
  }
  if (snapshot.connectionState === 'faulted') {
    return 'Needs attention';
  }
  if (snapshot.connectionState === 'stopped') {
    return 'Stopped';
  }
  return 'Ready';
}

function sessionLabel(snapshot: WebviewSnapshot): string {
  return snapshot.sessionName ?? snapshot.sessionId ?? snapshot.sessionFile ?? 'No session yet';
}

function modelLabel(snapshot: WebviewSnapshot): string {
  return snapshot.model?.provider && snapshot.model?.id
    ? `${snapshot.model.provider}/${snapshot.model.id}`
    : 'Model not selected';
}

function renderMessages(snapshot: WebviewSnapshot): string {
  if (snapshot.messages.length === 0) {
    return '<div class="empty-state">No messages yet. Start Pi, then send your first prompt.</div>';
  }
  return snapshot.messages
    .map(
      (message) => `
        <article class="message message-${escapeHtml(message.role)}">
          <h3>${escapeHtml(message.role)}</h3>
          <pre>${escapeHtml(message.text)}</pre>
          ${renderAttachments(message.attachments)}
        </article>`
    )
    .join('');
}

function renderStatusRows(snapshot: WebviewSnapshot): string {
  const rows = Object.entries(snapshot.statuses);
  if (rows.length === 0) {
    return '<div class="empty-state">No keyed statuses</div>';
  }
  return rows
    .map(([key, value]) => `<div><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`)
    .join('');
}

function renderQueue(snapshot: WebviewSnapshot): string {
  if (snapshot.queue.steering.length === 0 && snapshot.queue.followUp.length === 0) {
    return '<div class="empty-state">No queued notes right now.</div>';
  }
  return `
    <div class="queue"><strong>Steering notes:</strong> ${escapeHtml(snapshot.queue.steering.join(' · ') || 'empty')}</div>
    <div class="queue"><strong>Follow-up notes:</strong> ${escapeHtml(snapshot.queue.followUp.join(' · ') || 'empty')}</div>`;
}

export function renderChatApp(snapshot: WebviewSnapshot): string {
  const aboveWidgets = snapshot.widgets.filter((widget) => widget.placement === 'aboveEditor');
  const belowWidgets = snapshot.widgets.filter((widget) => widget.placement === 'belowEditor');
  const pendingImages =
    snapshot.pendingImages.length > 0
      ? `<div>${snapshot.pendingImages
          .map(
            (image) =>
              `<span class="pill">${escapeHtml(image.name)} · ${escapeHtml(image.mimeType)} · ${image.size}b</span>`
          )
          .join('')}</div>`
      : '<div class="empty-state">No images selected</div>';

  return `
    <div class="layout" data-testid="chat-app">
      <header class="chat-header" role="banner">
        <div>
          <p class="eyebrow">Pi RPC Chat</p>
          <h1>${escapeHtml(snapshot.title)}</h1>
          <dl class="header-meta" aria-label="Current session summary">
            <div><dt>Workspace</dt><dd>${escapeHtml(snapshot.workspaceFolderName)}</dd></div>
            <div><dt>Session</dt><dd>${escapeHtml(sessionLabel(snapshot))}</dd></div>
            <div><dt>Model</dt><dd>${escapeHtml(modelLabel(snapshot))}</dd></div>
            <div><dt>Status</dt><dd>${escapeHtml(connectionSummary(snapshot))}</dd></div>
          </dl>
        </div>
        <div class="header-actions" aria-label="Primary chat actions">
          <button data-command="piRpcInternal.start" aria-label="Start Pi for this workspace">Start Pi</button>
          <button data-command="piRpc.newSession" aria-label="Create a new Pi session">New Session</button>
          <button data-command="piRpc.switchSession" aria-label="Resume a saved Pi session">Resume Session</button>
          <button data-action="refresh" aria-label="Refresh current session state">Refresh</button>
          <button data-command="piRpc.abort" aria-label="Abort the current Pi run">Abort</button>
        </div>
      </header>

      <section class="surface">
        <label class="stacked-form" for="folder-select">
          <span>Active workspace</span>
          <select id="folder-select" aria-label="Active workspace folder">
            ${snapshot.folders
              .map(
                (folder) =>
                  `<option value="${escapeHtml(folder.uri)}" ${folder.active ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`
              )
              .join('')}
          </select>
        </label>
        <div class="header-flags" role="status" aria-live="polite">
          <span class="pill">${snapshot.isTrusted ? 'Trusted workspace' : 'Restricted mode'}</span>
          ${typeof snapshot.pendingMessageCount === 'number' ? `<span class="pill">${snapshot.pendingMessageCount} waiting</span>` : ''}
          ${typeof snapshot.messageCount === 'number' ? `<span class="pill">${snapshot.messageCount} messages</span>` : ''}
          ${snapshot.thinkingLevel ? `<span class="pill">Thinking: ${escapeHtml(snapshot.thinkingLevel)}</span>` : ''}
        </div>
      </section>

      <section class="surface" aria-labelledby="composer-heading">
        <h2 id="composer-heading">Ask Pi</h2>
        ${pendingImages}
        ${renderWidgets(aboveWidgets)}
        <textarea id="draft" rows="6" aria-label="Prompt">${escapeHtml(snapshot.draft)}</textarea>
        ${renderWidgets(belowWidgets)}
        <div class="buttons" aria-label="Send prompt actions">
          <button data-mode="prompt">Send</button>
          <button data-mode="steer">Add Steering Note</button>
          <button data-mode="followUp">Queue Follow-up</button>
          <button data-action="pickImages">Pick Images</button>
          <button data-action="clearImages">Clear Images</button>
          <button data-action="appendActiveFile">Use Active File</button>
          <button data-action="appendPickedFile">Pick File</button>
          <button data-action="appendSelection">Use Selection</button>
          <button data-action="appendDiagnostics">Use Diagnostics</button>
        </div>
      </section>

      <details class="surface" open>
        <summary>Conversation</summary>
        <div aria-live="polite" id="messages">${renderMessages(snapshot)}</div>
      </details>

      <details class="surface" open>
        <summary>Queues</summary>
        ${renderQueue(snapshot)}
        <div class="buttons">
          <button data-command="piRpc.setSteeringMode">Steering Mode</button>
          <button data-command="piRpc.setFollowUpMode">Follow-up Mode</button>
          <button data-command="piRpc.toggleAutoRetry">Auto Retry</button>
          <button data-command="piRpc.abortRetry">Abort Retry</button>
        </div>
      </details>

      <details class="surface">
        <summary>Workflow & Models</summary>
        <div class="buttons">
          <button data-command="piRpc.showModels">Choose Model</button>
          <button data-command="piRpc.cycleModel">Cycle Model</button>
          <button data-command="piRpc.setThinkingLevel">Set Thinking Level</button>
          <button data-command="piRpc.cycleThinkingLevel">Cycle Thinking</button>
          <button data-command="piRpc.showPiCommands">Show Pi Commands</button>
          <button data-command="piRpc.compact">Compact Conversation</button>
          <button data-command="piRpc.toggleAutoCompaction">Auto Compaction</button>
        </div>
      </details>

      <details class="surface">
        <summary>Session Tools</summary>
        <form id="rename-session-form" class="stacked-form">
          <input id="rename-session-name" placeholder="session name" aria-label="Rename current session" />
          <button type="submit">Rename Session</button>
        </form>
        <div class="buttons">
          <button data-command="piRpc.forkSession">Start Branch</button>
          <button data-command="piRpc.cloneSession">Duplicate Path</button>
          <button data-command="piRpc.showForkMessages">Branch Starting Points</button>
          <button data-command="piRpc.showSessionTree">Conversation Map</button>
          <button data-command="piRpc.refreshEntries">Refresh Branches</button>
        </div>
      </details>

      <details class="surface">
        <summary>Status & Widgets</summary>
        ${renderStatusRows(snapshot)}
        <form id="status-form" class="stacked-form">
          <input id="status-key" placeholder="status key" aria-label="Status key" />
          <input id="status-text" placeholder="status text (blank clears)" aria-label="Status text" />
          <button type="submit">Set Status</button>
        </form>
        <div class="widget-column">
          <div><strong>Above editor</strong>${renderWidgets(aboveWidgets)}</div>
          <div><strong>Below editor</strong>${renderWidgets(belowWidgets)}</div>
        </div>
        <form id="widget-form" class="stacked-form">
          <input id="widget-key" placeholder="widget key" aria-label="Widget key" />
          <select id="widget-placement" aria-label="Widget placement"><option value="aboveEditor">Above editor</option><option value="belowEditor">Below editor</option></select>
          <textarea id="widget-lines" rows="3" placeholder="one line per row" aria-label="Widget lines"></textarea>
          <button type="submit">Set Widget</button>
        </form>
      </details>

      <details class="surface">
        <summary>Advanced</summary>
        <form id="bash-form" class="stacked-form">
          <input id="bash-command" placeholder="bash command" aria-label="Run bash command" />
          <label><input type="checkbox" id="bash-exclude" /> Exclude from next prompt context</label>
          <button type="submit">Run Bash</button>
        </form>
        <form id="title-form" class="stacked-form">
          <input id="chat-title" placeholder="chat title" aria-label="Set chat title" />
          <button type="submit">Set Title</button>
        </form>
        <div class="buttons">
          <button data-command="piRpc.abortBash">Abort Bash</button>
          <button data-command="piRpc.showSessionStats">Session Stats</button>
          <button data-command="piRpc.exportHtml">Export HTML</button>
          <button data-command="piRpc.copyLastAssistant">Copy Last Assistant</button>
          <button data-command="piRpc.inspectRpcError">RPC Errors</button>
          <button data-command="piRpc.inspectParseError">Parse Errors</button>
          <button data-command="piRpc.inspectExtensionError">Extension Errors</button>
          <button data-command="piRpc.inspectCompatibilityEvents">Compatibility Events</button>
          <button data-command="piRpcInternal.showHealth">Health</button>
          <button data-command="piRpcInternal.exportDiagnostics">Export Diagnostics</button>
        </div>
      </details>

      <details class="surface">
        <summary>Extension UI</summary>
        <div class="buttons">
          <button data-command="piRpc.extensionUi.select">Select Dialog</button>
          <button data-command="piRpc.extensionUi.confirm">Confirm Dialog</button>
          <button data-command="piRpc.extensionUi.input">Input Dialog</button>
          <button data-command="piRpc.extensionUi.editor">Editor Dialog</button>
          <button data-command="piRpc.extensionUi.notify">Notify</button>
          <button data-command="piRpc.extensionUi.setEditorText">Set Draft</button>
          <button data-command="piRpc.respondExtensionUi">Inspect Responses</button>
        </div>
        <div class="buttons">
          <button data-command="piRpc.extensionUiLocal.onTerminalInput">onTerminalInput</button>
          <button data-command="piRpc.extensionUiLocal.custom">custom()</button>
          <button data-command="piRpc.extensionUiLocal.pasteToEditor">pasteToEditor()</button>
          <button data-command="piRpc.extensionUiLocal.setTheme">setTheme()</button>
          <button data-command="piRpc.extensionUiLocal.getAllThemes">getAllThemes()</button>
        </div>
      </details>
    </div>
  `;
}
