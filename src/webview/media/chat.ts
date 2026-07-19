declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

interface Snapshot {
  sequence: number;
  title: string;
  connectionState: string;
  workspaceFolderName: string;
  messages: Array<{
    id: string;
    role: string;
    text: string;
    attachments: Array<{
      id?: string;
      type: string;
      name?: string;
      mimeType?: string;
      size?: number;
      hasContent: boolean;
      extractedText?: string;
      previewItems: Array<{ key: string; value: string }>;
      fileRef?: { uri: string; path: string };
    }>;
  }>;
  queue: { steering: string[]; followUp: string[] };
  draft: string;
  statuses: Record<string, string>;
  widgets: Array<{ key: string; lines: string[]; placement: 'aboveEditor' | 'belowEditor' }>;
  thinkingLevel?: string;
  model?: { provider?: string; id?: string } | null;
  pendingImages: Array<{ name: string; mimeType: string; size: number }>;
  isTrusted: boolean;
  folders: Array<{ name: string; uri: string; active: boolean }>;
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('app');

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderAttachment(attachment: Snapshot['messages'][number]['attachments'][number]): string {
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
      ${attachment.fileRef ? `<button type="button" data-attachment-uri="${escapeHtml(attachment.fileRef.uri)}">Open ${escapeHtml(attachment.fileRef.path)}</button>` : ''}
    </div>`;
}

function renderAttachments(attachments: Snapshot['messages'][number]['attachments']): string {
  if (attachments.length === 0) {
    return '';
  }
  return `<div class="attachment-strip">${attachments.map((attachment) => renderAttachment(attachment)).join('')}</div>`;
}

function render(snapshot: Snapshot): void {
  if (!root) {
    return;
  }
  const aboveWidgets = snapshot.widgets.filter((widget) => widget.placement === 'aboveEditor');
  const belowWidgets = snapshot.widgets.filter((widget) => widget.placement === 'belowEditor');
  root.innerHTML = `
    <header>
      <h1>${escapeHtml(snapshot.title)}</h1>
      <p>${escapeHtml(snapshot.workspaceFolderName)} · ${escapeHtml(snapshot.connectionState)} · ${escapeHtml(snapshot.model?.provider ?? 'provider')}/${escapeHtml(snapshot.model?.id ?? 'none')} · ${escapeHtml(snapshot.thinkingLevel ?? 'n/a')} · ${snapshot.isTrusted ? 'trusted' : 'restricted'}</p>
      <label>
        Active folder
        <select id="folder-select">
          ${snapshot.folders
            .map(
              (folder) =>
                `<option value="${escapeHtml(folder.uri)}" ${folder.active ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`
            )
            .join('')}
        </select>
      </label>
    </header>
    <section>
      <h2>Messages</h2>
      <div aria-live="polite" id="messages">
        ${snapshot.messages
          .map(
            (message) => `
              <article class="message message-${escapeHtml(message.role)}">
                <h3>${escapeHtml(message.role)}</h3>
                <pre>${escapeHtml(message.text)}</pre>
                ${renderAttachments(message.attachments)}
              </article>`
          )
          .join('')}
      </div>
    </section>
    <section>
      <h2>Queue</h2>
      <div class="queue"><strong>Steer:</strong> ${escapeHtml(snapshot.queue.steering.join(' · ') || 'empty')}</div>
      <div class="queue"><strong>Follow-up:</strong> ${escapeHtml(snapshot.queue.followUp.join(' · ') || 'empty')}</div>
      <div class="buttons">
        <button data-command="piRpc.setSteeringMode">Steering Mode</button>
        <button data-command="piRpc.setFollowUpMode">Follow-up Mode</button>
        <button data-command="piRpc.toggleAutoRetry">Auto Retry</button>
        <button data-command="piRpc.abortRetry">Abort Retry</button>
      </div>
    </section>
    <section>
      <h2>Status</h2>
      ${
        Object.entries(snapshot.statuses)
          .map(
            ([key, value]) => `<div><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</div>`
          )
          .join('') || '<div>No keyed statuses</div>'
      }
      <form id="status-form" class="stacked-form">
        <input id="status-key" placeholder="status key" />
        <input id="status-text" placeholder="status text (blank clears)" />
        <button type="submit">Set Status</button>
      </form>
    </section>
    <section>
      <h2>Widgets</h2>
      <div class="widget-column">
        <div><strong>Above editor</strong>${renderWidgets(aboveWidgets)}</div>
        <div><strong>Below editor</strong>${renderWidgets(belowWidgets)}</div>
      </div>
      <form id="widget-form" class="stacked-form">
        <input id="widget-key" placeholder="widget key" />
        <select id="widget-placement"><option value="aboveEditor">Above editor</option><option value="belowEditor">Below editor</option></select>
        <textarea id="widget-lines" rows="3" placeholder="one line per row"></textarea>
        <button type="submit">Set Widget</button>
      </form>
    </section>
    <section>
      <h2>Composer</h2>
      ${snapshot.pendingImages.length > 0 ? `<div>${snapshot.pendingImages.map((image) => `<span class="pill">${escapeHtml(image.name)} · ${escapeHtml(image.mimeType)} · ${image.size}b</span>`).join('')}</div>` : '<div>No images selected</div>'}
      ${renderWidgets(aboveWidgets)}
      <textarea id="draft" rows="6" aria-label="Prompt">${escapeHtml(snapshot.draft)}</textarea>
      ${renderWidgets(belowWidgets)}
      <div class="buttons">
        <button data-mode="prompt">Send</button>
        <button data-mode="steer">Steer</button>
        <button data-mode="followUp">Follow-up</button>
        <button data-action="pickImages">Pick Images</button>
        <button data-action="clearImages">Clear Images</button>
        <button data-action="appendActiveFile">Use Active File</button>
        <button data-action="appendPickedFile">Pick File</button>
        <button data-action="appendSelection">Use Selection</button>
        <button data-action="appendDiagnostics">Use Diagnostics</button>
      </div>
    </section>
    <section>
      <h2>Models & Thinking</h2>
      <div class="buttons">
        <button data-command="piRpc.showModels">Models</button>
        <button data-command="piRpc.cycleModel">Cycle Model</button>
        <button data-command="piRpc.setThinkingLevel">Thinking Level</button>
        <button data-command="piRpc.cycleThinkingLevel">Cycle Thinking</button>
      </div>
    </section>
    <section>
      <h2>Sessions</h2>
      <form id="switch-session-form" class="stacked-form">
        <input id="switch-session-path" placeholder="session path" />
        <button type="submit">Switch Session</button>
      </form>
      <form id="rename-session-form" class="stacked-form">
        <input id="rename-session-name" placeholder="session name" />
        <button type="submit">Rename Session</button>
      </form>
      <div class="buttons">
        <button data-command="piRpc.newSession">New Session</button>
        <button data-command="piRpc.forkSession">Fork</button>
        <button data-command="piRpc.cloneSession">Clone</button>
        <button data-command="piRpc.showForkMessages">Fork Messages</button>
        <button data-command="piRpc.showSessionTree">Session Tree</button>
        <button data-command="piRpc.refreshEntries">Refresh Entries</button>
      </div>
    </section>
    <section>
      <h2>Commands & Workflow</h2>
      <div class="buttons">
        <button data-command="piRpc.showPiCommands">Pi Commands</button>
        <button data-command="piRpc.compact">Compact</button>
        <button data-command="piRpc.toggleAutoCompaction">Auto Compaction</button>
        <button data-command="piRpc.abort">Abort</button>
        <button data-command="piRpc.refreshState">Refresh State</button>
        <button data-command="piRpc.refreshMessages">Refresh Messages</button>
      </div>
    </section>
    <section>
      <h2>Bash, Export, Diagnostics</h2>
      <form id="bash-form" class="stacked-form">
        <input id="bash-command" placeholder="bash command" />
        <label><input type="checkbox" id="bash-exclude" /> Exclude from next prompt context</label>
        <button type="submit">Run Bash</button>
      </form>
      <form id="title-form" class="stacked-form">
        <input id="chat-title" placeholder="chat title" />
        <button type="submit">Set Title</button>
      </form>
      <div class="buttons">
        <button data-command="piRpc.abortBash">Abort Bash</button>
        <button data-command="piRpc.showSessionStats">Stats</button>
        <button data-command="piRpc.exportHtml">Export HTML</button>
        <button data-command="piRpc.copyLastAssistant">Copy Last Assistant</button>
        <button data-command="piRpc.inspectRpcError">RPC Errors</button>
        <button data-command="piRpc.inspectParseError">Parse Errors</button>
        <button data-command="piRpc.inspectExtensionError">Extension Errors</button>
        <button data-command="piRpc.inspectCompatibilityEvents">Compatibility Events</button>
        <button data-command="piRpcInternal.showHealth">Health</button>
        <button data-command="piRpcInternal.exportDiagnostics">Export Diagnostics</button>
      </div>
    </section>
    <section>
      <h2>Extension UI</h2>
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
    </section>
    <section class="buttons">
      <button data-action="abort">Abort</button>
      <button data-action="refresh">Refresh</button>
    </section>
  `;

  const textarea = document.getElementById('draft') as HTMLTextAreaElement | null;
  textarea?.addEventListener('input', () => {
    vscode.postMessage({ type: 'setDraft', text: textarea.value });
  });
  document.getElementById('folder-select')?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    vscode.postMessage({ type: 'switchFolder', folderUri: target.value });
  });
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-mode]'))) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'send', mode: button.dataset.mode, text: textarea?.value ?? '' });
    });
  }
  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-action]')
  )) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: button.dataset.action });
    });
  }
  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-command]')
  )) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'executeCommand', command: button.dataset.command });
    });
  }
  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-attachment-uri]')
  )) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'openAttachment', uri: button.dataset.attachmentUri });
    });
  }
  bindForms();
}

function renderWidgets(widgets: Snapshot['widgets']): string {
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

function bindForms(): void {
  bindForm('status-form', () => {
    const key = (document.getElementById('status-key') as HTMLInputElement | null)?.value ?? '';
    const text = (document.getElementById('status-text') as HTMLInputElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.extensionUi.setStatus',
      argument: { key, text },
    });
  });
  bindForm('widget-form', () => {
    const key = (document.getElementById('widget-key') as HTMLInputElement | null)?.value ?? '';
    const placement =
      (document.getElementById('widget-placement') as HTMLSelectElement | null)?.value ??
      'aboveEditor';
    const lines =
      (document.getElementById('widget-lines') as HTMLTextAreaElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.extensionUi.setWidget',
      argument: { key, placement, lines },
    });
  });
  bindForm('switch-session-form', () => {
    const sessionPath =
      (document.getElementById('switch-session-path') as HTMLInputElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.switchSession',
      argument: { sessionPath },
    });
  });
  bindForm('rename-session-form', () => {
    const name =
      (document.getElementById('rename-session-name') as HTMLInputElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.renameSession',
      argument: { name },
    });
  });
  bindForm('bash-form', () => {
    const command =
      (document.getElementById('bash-command') as HTMLInputElement | null)?.value ?? '';
    const exclude =
      (document.getElementById('bash-exclude') as HTMLInputElement | null)?.checked ?? false;
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.runBash',
      argument: { command, excludeFromContext: exclude },
    });
  });
  bindForm('title-form', () => {
    const title = (document.getElementById('chat-title') as HTMLInputElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.extensionUi.setTitle',
      argument: { title },
    });
  });
}

function bindForm(id: string, onSubmit: () => void): void {
  root?.querySelector<HTMLFormElement>(`#${id}`)?.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit();
  });
}

window.addEventListener('message', (event: MessageEvent<{ type: string; snapshot: Snapshot }>) => {
  if (event.data?.type === 'snapshot') {
    render(event.data.snapshot);
  }
});
