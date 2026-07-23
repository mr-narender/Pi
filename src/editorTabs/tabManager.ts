import * as vscode from 'vscode';
import { basename } from 'node:path';
import { getSettings } from '../config/settings';
import { ensureTrustedForMutation } from '../security/trust';
import { SessionRegistry } from '../sessions/sessionRegistry';
import type { SessionController } from '../sessions/sessionController';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import { createWebviewSnapshot, firstPromptPreview } from '../webview/model';
import { parseWebviewMessage } from '../webview/messages';
import {
  acceptedSnapshotFromPreview,
  boundDiagnosticsContent,
  boundFileContent,
  buildSendPreview,
  fingerprint,
  createEmptyComposerState,
  type PendingContextItem,
  type PendingImageItem,
} from '../webview/composer';
import { conversationToMarkdown } from '../webview/conversationMarkdown';
import { ChatUiState } from '../webview/composerState';
import type { JsonObject } from '../rpc/protocol';
import type { WebviewSnapshot } from '../state/types';
import { renderChatWebviewHtml } from '../webview/html';
import {
  CHAT_EDITOR_VIEW_TYPE,
  CHAT_URI_SCHEME,
  buildChatUri,
  chatTargetSessionKey,
  parseChatUri,
  tabTitleFromTarget,
  normalizeSessionFilePath,
  type ChatTabTarget,
} from './uri';
import { ChatTabStateCache, toPersistedChatSnapshot } from './sessionCache';
import type { ChatEditorDocument } from './document';
import { vscodeLanguageId } from './languageId';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function isDefaultTitle(value: string | undefined): boolean {
  return !value || value === 'Pi' || value === 'Pi RPC';
}

function safeParseUri(value: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(value, true);
  } catch {
    return undefined;
  }
}

function sameTarget(left: ChatTabTarget, right: ChatTabTarget): boolean {
  return chatTargetSessionKey(left) === chatTargetSessionKey(right);
}

function currentTargetForController(controller: SessionController): ChatTabTarget {
  const sessionFile =
    typeof controller.snapshot.state.sessionFile === 'string'
      ? controller.snapshot.state.sessionFile
      : undefined;
  const sessionId =
    typeof controller.snapshot.state.sessionId === 'string'
      ? controller.snapshot.state.sessionId
      : undefined;
  if (sessionFile) {
    return {
      workspaceFolderUri: controller.folder.uri.toString(),
      kind: 'sessionFile',
      sessionFile,
    };
  }
  if (sessionId) {
    return {
      workspaceFolderUri: controller.folder.uri.toString(),
      kind: 'sessionId',
      sessionId,
    };
  }
  return {
    workspaceFolderUri: controller.folder.uri.toString(),
    kind: 'workspaceDraft',
  };
}

function workspaceFolders(registry: SessionRegistry) {
  return registry.list().map((item) => ({
    name: item.folder.name,
    uri: item.folder.uri.toString(),
    active: item.folder.uri.toString() === registry.getActive()?.folder.uri.toString(),
  }));
}

function relativeWorkspacePath(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri
): string | undefined {
  if (uri.scheme !== 'file' || folder.uri.scheme !== 'file') {
    return undefined;
  }
  const owningFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!owningFolder || owningFolder.uri.toString() !== folder.uri.toString()) {
    return undefined;
  }
  const relative = vscode.workspace.asRelativePath(uri, false);
  return relative.startsWith('..') ? undefined : relative.replaceAll('\\', '/');
}

function diagnosticSeverity(
  diagnostics: readonly vscode.Diagnostic[]
): 'error' | 'warning' | 'info' | 'hint' | 'mixed' {
  const severities = new Set(diagnostics.map((item) => item.severity));
  if (severities.size > 1) {
    return 'mixed';
  }
  const only = diagnostics[0]?.severity;
  if (only === vscode.DiagnosticSeverity.Error) {
    return 'error';
  }
  if (only === vscode.DiagnosticSeverity.Warning) {
    return 'warning';
  }
  if (only === vscode.DiagnosticSeverity.Information) {
    return 'info';
  }
  return 'hint';
}

class ChatEditorHost implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private attachmentFileUris = new Set<string>();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    public readonly document: ChatEditorDocument,
    public readonly panel: vscode.WebviewPanel,
    private readonly manager: ChatTabManager
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [extensionUri, vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    this.panel.webview.html = renderChatWebviewHtml(extensionUri, this.panel.webview, 'Pi Chat');
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(
        (message: unknown) => void this.manager.onMessage(this, message)
      ),
      this.panel.onDidDispose(() => void this.manager.onHostDisposed(this)),
      this.panel.onDidChangeViewState(
        (event) => void this.manager.onHostViewStateChanged(this, event.webviewPanel.active)
      )
    );
  }

  public get resource(): vscode.Uri {
    return this.document.uri;
  }

  public async postSnapshot(snapshot: WebviewSnapshot, title: string): Promise<void> {
    this.panel.title = title;
    this.attachmentFileUris = new Set(
      snapshot.messages.flatMap((message) =>
        message.attachments
          .map((attachment) => attachment.fileRef?.uri)
          .filter((uri): uri is string => typeof uri === 'string')
      )
    );
    // IMPORTANT: do not await postMessage here. When this host is created from
    // resolveCustomEditor, VS Code only establishes the webview messaging
    // channel after resolveCustomEditor returns. Awaiting the post therefore
    // deadlocks the editor on a permanent loading indicator. VS Code buffers
    // messages sent before the webview is ready and delivers them on load.
    void this.panel.webview.postMessage({ type: 'snapshot', snapshot });
  }

  public hasAttachment(uri: string): boolean {
    return this.attachmentFileUris.has(uri);
  }

  public reveal(): void {
    this.panel.reveal(this.panel.viewColumn, false);
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

export interface ChatTabContext {
  controller: SessionController;
  resource: vscode.Uri;
  target: ChatTabTarget;
}

export class ChatTabManager implements vscode.Disposable {
  private readonly cache: ChatTabStateCache;
  private readonly hosts = new Map<string, ChatEditorHost>();
  private readonly resourceSequence = new Map<string, number>();
  private readonly activeResourceByWorkspace = new Map<string, string>();
  // Per-resource count of trailing messages currently revealed to the webview.
  // Starts at the configured window size and grows when the webview asks for
  // older batches on scroll-up.
  private readonly revealedMessageCounts = new Map<string, number>();
  private readonly controllerSubscriptions: vscode.Disposable[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: SessionRegistry,
    private readonly uiState: ChatUiState,
    private readonly logger: DiagnosticsLogger
  ) {
    this.cache = new ChatTabStateCache(context);
    for (const controller of registry.list()) {
      this.trackController(controller);
    }
    // Remember the last real text editor so "Insert at cursor" targets the code,
    // not the chat webview (which isn't a text editor).
    this.lastTextEditor = this.pickTextEditor(vscode.window.activeTextEditor);
    this.controllerSubscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const real = this.pickTextEditor(editor);
        if (real) {
          this.lastTextEditor = real;
        }
      })
    );
  }

  private lastTextEditor: vscode.TextEditor | undefined;

  private pickTextEditor(editor: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
    return editor && editor.document.uri.scheme !== CHAT_URI_SCHEME ? editor : undefined;
  }

  /** Replace the selection (or insert at the cursor) in the last real editor. */
  private async insertCodeIntoEditor(text: string): Promise<void> {
    const editor = this.pickTextEditor(vscode.window.activeTextEditor) ?? this.lastTextEditor;
    if (!editor) {
      await this.openCodeInNewFile(text, undefined);
      return;
    }
    try {
      const shown = await vscode.window.showTextDocument(editor.document, {
        viewColumn: editor.viewColumn,
        preserveFocus: false,
      });
      await shown.edit((builder) => builder.replace(shown.selection, text));
    } catch {
      // The tracked editor may have been closed; fall back to a fresh file.
      await this.openCodeInNewFile(text, undefined);
    }
  }

  /** Open the code in a new untitled document with the right language. */
  private async openCodeInNewFile(text: string, language?: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      content: text,
      language: vscodeLanguageId(language),
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  public dispose(): void {
    for (const disposable of this.controllerSubscriptions) {
      disposable.dispose();
    }
    for (const host of this.hosts.values()) {
      host.dispose();
    }
    this.hosts.clear();
    this.cache.dispose();
  }

  public trackController(controller: SessionController): void {
    this.controllerSubscriptions.push(
      controller.onDidChangeState(() => void this.onControllerChanged(controller))
    );
  }

  public async resolveEditor(
    document: ChatEditorDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const key = this.keyFor(document.uri);
    this.hosts.get(key)?.dispose();
    const host = new ChatEditorHost(this.context.extensionUri, document, panel, this);
    this.hosts.set(key, host);
    // resolveCustomEditor MUST NOT reject: a rejected promise here makes VS Code
    // fail the editor input resolution and surface an internal
    // "Assertion Failed: Argument is undefined or null". The webview shell is
    // already created above, so on any error we simply leave the tab in its
    // rendered (connecting/faulted) state.
    try {
      await this.cache.markOpen(document.uri);
      await this.renderResource(document.uri, { active: panel.active });
      if (panel.active) {
        await this.activateResource(document.uri, { startIfStopped: false });
      }
    } catch (error) {
      this.logger.error(`Failed to resolve chat editor for ${document.uri.toString()}`, error);
      /* keep the tab open; connection/faulted state is rendered by the webview */
    }
    // Auto-start Pi in the background so the tab transitions from a
    // "Connecting…" state to an interactive composer without the user having
    // to trigger it. The webview keeps the composer disabled until the
    // connection is ready; start failures surface as the faulted state.
    const openContext = this.contextForResource(document.uri);
    if (openContext && openContext.controller.snapshot.connectionState === 'stopped') {
      void this.startResource(document.uri).catch(() => {
        /* faulted connection state is rendered by renderResource */
      });
    }
  }

  private nextSessionNumber(): number {
    const key = 'piRpc.sessionCounter';
    const next = (this.context.workspaceState.get<number>(key) ?? 0) + 1;
    void this.context.workspaceState.update(key, next);
    return next;
  }

  public async nameSessionIfUnnamed(controller: SessionController): Promise<void> {
    const existing = controller.snapshot.state.sessionName;
    if (typeof existing === 'string' && existing.trim()) {
      return;
    }
    try {
      await controller.renameSession(`Session ${this.nextSessionNumber()}`);
    } catch {
      /* naming is best-effort; the tab still works with a fallback title */
    }
  }

  public async appendComposerCommand(text: string): Promise<void> {
    const context = this.getActiveContext();
    if (!context) {
      return;
    }
    const state = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    const base = state.draft && !state.draft.endsWith(' ') ? `${state.draft} ` : state.draft;
    state.draft = `${base}${text}`;
    state.composerResetSeq = (state.composerResetSeq ?? 0) + 1;
    state.focus = 'composer';
    await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
    await this.renderResource(context.resource);
  }

  /** Full active conversation as Markdown (whole transcript), for copy/export. */
  public getActiveConversationMarkdown(): { title: string; markdown: string } | undefined {
    const context = this.getActiveContext();
    if (!context) {
      return undefined;
    }
    const snapshot = createWebviewSnapshot(context.controller.snapshot, 0, {
      uiMode: this.uiState.getMode(),
      composer: createEmptyComposerState(),
      isTrusted: vscode.workspace.isTrusted,
      folders: [],
      messageLimit: Number.MAX_SAFE_INTEGER,
    });
    return {
      title: snapshot.title,
      markdown: conversationToMarkdown(snapshot.messages, snapshot.title),
    };
  }

  public getActiveContext(): ChatTabContext | undefined {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = (activeTab?.input ?? undefined) as
      | { uri?: vscode.Uri; viewType?: string }
      | undefined;
    if (input?.viewType !== CHAT_EDITOR_VIEW_TYPE || !input.uri) {
      return undefined;
    }
    return this.contextForResource(input.uri);
  }

  public async refreshVisibleTabs(): Promise<void> {
    for (const host of this.hosts.values()) {
      await this.renderResource(host.resource, { active: host.panel.active });
    }
  }

  public async closeForSessionFile(sessionFile: string): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = (tab.input ?? undefined) as
          | { uri?: vscode.Uri; viewType?: string }
          | undefined;
        if (input?.viewType !== CHAT_EDITOR_VIEW_TYPE || !input.uri) {
          continue;
        }
        const target = parseChatUri(input.uri);
        if (
          target?.kind === 'sessionFile' &&
          target.sessionFile &&
          normalizeSessionFilePath(target.sessionFile) === normalizeSessionFilePath(sessionFile)
        ) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }

  public async focusComposer(resource = this.getActiveContext()?.resource): Promise<void> {
    if (!resource) {
      return;
    }
    const context = this.contextForResource(resource);
    if (!context) {
      return;
    }
    await this.uiState.setFocusForIdentity(context.controller, context.target, 'composer');
    await this.renderResource(resource);
  }

  public async openCurrentChat(options?: {
    folderUri?: string;
    focusComposer?: boolean;
  }): Promise<vscode.Uri | undefined> {
    const activeContext = this.getActiveContext();
    if (activeContext && !options?.folderUri) {
      if (options?.focusComposer) {
        await this.focusComposer(activeContext.resource);
      }
      await this.openResource(activeContext.resource);
      return activeContext.resource;
    }

    let controller = options?.folderUri
      ? this.registry.getByFolderUri(options.folderUri)
      : undefined;
    if (!controller) {
      const editorFolder = vscode.window.activeTextEditor
        ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
        : undefined;
      controller = editorFolder ? this.registry.getOrCreate(editorFolder) : undefined;
    }
    if (!controller) {
      controller = await this.registry.getSelectedOrPick();
    }
    if (!controller) {
      return undefined;
    }
    this.registry.setActive(controller);
    const resource = buildChatUri(currentTargetForController(controller));
    if (options?.focusComposer) {
      await this.uiState.setFocusForIdentity(
        controller,
        currentTargetForController(controller),
        'composer'
      );
    }
    await this.openResource(resource);
    return resource;
  }

  public async openTarget(
    target: ChatTabTarget,
    options?: { focusComposer?: boolean }
  ): Promise<vscode.Uri> {
    const resource = buildChatUri(target);
    const context = this.contextForResource(resource);
    if (context && options?.focusComposer) {
      await this.uiState.setFocusForIdentity(context.controller, context.target, 'composer');
    }
    await this.openResource(resource);
    return resource;
  }

  public async startResource(resource: vscode.Uri): Promise<ChatTabContext | undefined> {
    return this.activateResource(resource, { startIfStopped: true });
  }

  public async activateResource(
    resource: vscode.Uri,
    options?: { startIfStopped?: boolean }
  ): Promise<ChatTabContext | undefined> {
    const context = this.contextForResource(resource);
    if (!context) {
      return undefined;
    }
    this.registry.setActive(context.controller);
    const workspaceKey = context.target.workspaceFolderUri;
    const previousResource = this.activeResourceByWorkspace.get(workspaceKey);
    this.activeResourceByWorkspace.set(workspaceKey, resource.toString());

    const connectionState = context.controller.snapshot.connectionState;
    // Loading/starting a session can fail (Pi missing, version mismatch, load
    // error). Never let that reject out of here — the controller records a
    // faulted state and the webview renders it; a throw would abort the caller
    // (including resolveCustomEditor) and trigger a VS Code assertion.
    try {
      if (context.target.kind === 'sessionFile' && context.target.sessionFile) {
        // Opening a saved session MUST load it into the controller. If Pi is not
        // running, start it directly on that session file. Otherwise WAIT until
        // the RPC client is actually usable before switching — the warm-start
        // sets state to 'starting' ~1s before the client exists, so switching
        // too early failed with "Pi is not started for this workspace".
        if (connectionState === 'stopped') {
          await context.controller.start(context.target.sessionFile);
          await context.controller.reconcile();
        } else {
          await context.controller.whenReady();
          if (!sameTarget(currentTargetForController(context.controller), context.target)) {
            await this.uiState.captureControllerDraft(context.controller);
            await context.controller.switchSession(context.target.sessionFile);
            await this.uiState.restoreControllerDraft(context.controller);
          }
        }
      } else if (options?.startIfStopped && connectionState === 'stopped') {
        await context.controller.start(undefined);
        await context.controller.reconcile();
      }
    } catch (error) {
      this.logger.error(
        `Failed to load session for ${context.target.sessionFile ?? context.target.kind}`,
        error
      );
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window
        .showErrorMessage(`Pi: couldn't load this chat — ${message}`, 'Show Logs')
        .then((choice) => {
          if (choice === 'Show Logs') {
            void vscode.commands.executeCommand('piRpcInternal.showLogs');
          }
        });
    }

    await this.renderResource(resource, { active: true });
    if (previousResource && previousResource !== resource.toString()) {
      const parsed = safeParseUri(previousResource);
      if (parsed) {
        await this.renderResource(parsed);
      }
    }
    return context;
  }

  public async preparePromptContext(resource: vscode.Uri): Promise<ChatTabContext | undefined> {
    const current = this.contextForResource(resource);
    if (!current) {
      return undefined;
    }
    if (current.target.kind !== 'workspaceDraft') {
      return this.activateResource(resource, { startIfStopped: true });
    }
    if (current.controller.snapshot.connectionState === 'stopped') {
      await current.controller.start();
      await current.controller.reconcile();
    }
    const draftState = await this.uiState.getComposerStateForIdentity(
      current.controller,
      current.target
    );
    const result = await current.controller.newSession();
    if (result?.cancelled === true) {
      return undefined;
    }
    await this.nameSessionIfUnnamed(current.controller);
    const nextTarget = currentTargetForController(current.controller);
    await this.uiState.setComposerStateForIdentity(current.controller, nextTarget, draftState);
    await this.uiState.clearComposerStateForIdentity(current.controller, current.target);
    const nextResource = buildChatUri(nextTarget);
    await this.promoteResource(resource, nextResource, current.controller);
    return this.activateResource(nextResource, { startIfStopped: false });
  }

  private findTabUriForSessionFile(sessionFile: string): vscode.Uri | undefined {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = (tab.input ?? undefined) as
          | { uri?: vscode.Uri; viewType?: string }
          | undefined;
        if (input?.viewType !== CHAT_EDITOR_VIEW_TYPE || !input.uri) {
          continue;
        }
        const target = parseChatUri(input.uri);
        if (
          target?.kind === 'sessionFile' &&
          target.sessionFile &&
          normalizeSessionFilePath(target.sessionFile) === normalizeSessionFilePath(sessionFile)
        ) {
          return input.uri;
        }
      }
    }
    return undefined;
  }

  public async openForSessionFile(
    controller: SessionController,
    sessionFile: string,
    options?: { focusComposer?: boolean }
  ): Promise<vscode.Uri> {
    // If a tab for this exact session is already open, reveal it instead of
    // opening a duplicate editor.
    const existing = this.findTabUriForSessionFile(sessionFile);
    if (existing) {
      const context = this.contextForResource(existing);
      if (context && options?.focusComposer) {
        await this.uiState.setFocusForIdentity(context.controller, context.target, 'composer');
      }
      await this.openResource(existing);
      return existing;
    }
    return this.openTarget(
      {
        workspaceFolderUri: controller.folder.uri.toString(),
        kind: 'sessionFile',
        sessionFile,
      },
      options
    );
  }

  public async openDraftForWorkspace(
    controller: SessionController,
    options?: { focusComposer?: boolean }
  ): Promise<vscode.Uri> {
    return this.openTarget(
      {
        workspaceFolderUri: controller.folder.uri.toString(),
        kind: 'workspaceDraft',
      },
      options
    );
  }

  public async promoteDraftToCurrentSession(controller: SessionController): Promise<vscode.Uri> {
    const draftTarget: ChatTabTarget = {
      workspaceFolderUri: controller.folder.uri.toString(),
      kind: 'workspaceDraft',
    };
    const nextTarget = currentTargetForController(controller);
    const draftResource = buildChatUri(draftTarget);
    const nextResource = buildChatUri(nextTarget);
    const draftState = await this.uiState.getComposerStateForIdentity(controller, draftTarget);
    await this.uiState.setComposerStateForIdentity(controller, nextTarget, draftState);
    await this.uiState.clearComposerStateForIdentity(controller, draftTarget);
    await this.promoteResource(draftResource, nextResource, controller);
    return nextResource;
  }

  public async onHostDisposed(host: ChatEditorHost): Promise<void> {
    const key = this.keyFor(host.resource);
    if (this.hosts.get(key) === host) {
      this.hosts.delete(key);
    }
    await this.cache.markClosed(host.resource);
  }

  public async onHostViewStateChanged(host: ChatEditorHost, active: boolean): Promise<void> {
    if (!active) {
      return;
    }
    await this.activateResource(host.resource, { startIfStopped: false });
  }

  public async onMessage(host: ChatEditorHost, message: unknown): Promise<void> {
    const parsed = parseWebviewMessage(message);
    const context = this.contextForResource(host.resource);
    if (!parsed || !context) {
      return;
    }

    switch (parsed.type) {
      case 'loadOlder':
        await this.revealOlderMessages(host.resource);
        return;
      case 'insertCode':
        await this.insertCodeIntoEditor(parsed.text);
        return;
      case 'newFileFromCode':
        await this.openCodeInNewFile(parsed.text, parsed.language);
        return;
      case 'requestSend':
        await this.handleRequestSend(host.resource, parsed.command);
        return;
      case 'acceptPreview':
        await this.acceptPreview(host.resource);
        return;
      case 'cancelPreview': {
        const state = await this.uiState.getComposerStateForIdentity(
          context.controller,
          context.target
        );
        state.preview = undefined;
        state.focus = 'composer';
        await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
        await this.renderResource(host.resource);
        return;
      }
      case 'copyAcceptedSnapshot':
        await this.uiState.copyAcceptedSnapshotToComposerForIdentity(
          context.controller,
          context.target
        );
        await this.renderResource(host.resource);
        return;
      case 'sendAcceptedSnapshotAgain': {
        const state = await this.uiState.getComposerStateForIdentity(
          context.controller,
          context.target
        );
        const command = state.acceptedSendSnapshot?.command;
        await this.uiState.copyAcceptedSnapshotToComposerForIdentity(
          context.controller,
          context.target
        );
        if (command) {
          await this.handleRequestSend(host.resource, command);
        } else {
          await this.renderResource(host.resource);
        }
        return;
      }
      case 'abort': {
        const live = await this.activateResource(host.resource, { startIfStopped: false });
        await live?.controller.abort();
        return;
      }
      case 'setDraft': {
        const state = await this.uiState.getComposerStateForIdentity(
          context.controller,
          context.target
        );
        state.draft = parsed.text;
        await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
        if (sameTarget(currentTargetForController(context.controller), context.target)) {
          // Silent: keep the controller draft in sync without firing a state
          // change, which would re-render the tab and reset the caret while the
          // user is typing.
          context.controller.setDraft(parsed.text, { silent: true });
        }
        return;
      }
      case 'setFocus':
        await this.uiState.setFocusForIdentity(context.controller, context.target, parsed.focus);
        return;
      case 'executeCommand':
        try {
          await vscode.commands.executeCommand(parsed.command, parsed.argument);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window
            .showErrorMessage(`Pi: ${parsed.command} failed — ${message}`, 'Show Logs')
            .then((choice) => {
              if (choice === 'Show Logs') {
                void vscode.commands.executeCommand('piRpcInternal.showLogs');
              }
            });
        }
        return;
      case 'pickImages':
        await this.pickImages(context.controller, context.target, host.resource);
        return;
      case 'clearAttachments':
        await this.uiState.clearAttachmentsForIdentity(context.controller, context.target);
        await this.renderResource(host.resource);
        return;
      case 'appendActiveFile': {
        const item = await this.captureActiveFile(context.controller);
        if (item) {
          await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
          await this.renderResource(host.resource);
        }
        return;
      }
      case 'appendSelection': {
        const item = await this.captureSelection(context.controller);
        if (item) {
          await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
          await this.renderResource(host.resource);
        }
        return;
      }
      case 'appendDiagnostics': {
        const item = await this.captureDiagnostics(context.controller);
        if (item) {
          await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
          await this.renderResource(host.resource);
        }
        return;
      }
      case 'appendPickedFile': {
        const item = await this.capturePickedFile(context.controller);
        if (item) {
          await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
          await this.renderResource(host.resource);
        }
        return;
      }
      case 'removeContextItem':
        await this.uiState.removeContextItemForIdentity(
          context.controller,
          context.target,
          parsed.itemId
        );
        await this.renderResource(host.resource);
        return;
      case 'removeImageItem':
        await this.uiState.removeImageItemForIdentity(
          context.controller,
          context.target,
          parsed.itemId
        );
        await this.renderResource(host.resource);
        return;
      case 'openAttachment':
        if (host.hasAttachment(parsed.uri)) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(parsed.uri, true));
        }
        return;
      case 'switchFolder': {
        this.registry.setActive(parsed.folderUri);
        await this.openCurrentChat({ folderUri: parsed.folderUri });
        return;
      }
      default:
        return;
    }
  }

  private async handleRequestSend(
    resource: vscode.Uri,
    command: 'prompt' | 'follow_up' | 'steer'
  ): Promise<void> {
    ensureTrustedForMutation();
    let context = this.contextForResource(resource);
    if (!context) {
      return;
    }
    let state = await this.uiState.getComposerStateForIdentity(context.controller, context.target);
    state.recovery = undefined;
    state.preview = undefined;
    try {
      const preview = buildSendPreview(command, state);
      if (state.pendingContextItems.length > 0 || state.pendingImages.length > 0) {
        state.preview = preview;
        state.focus = 'preview';
        await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
        await this.renderResource(resource);
        return;
      }
      context = await this.preparePromptContext(resource);
      if (!context) {
        return;
      }
      state = await this.uiState.getComposerStateForIdentity(context.controller, context.target);
      await this.sendPreview(context.resource, context.controller, context.target, state, preview);
    } catch (error) {
      if (!context) {
        return;
      }
      state.recovery = {
        kind: 'preflightError',
        title: 'Attachments need attention.',
        detail: error instanceof Error ? error.message : String(error),
      };
      await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
      await this.renderResource(resource);
    }
  }

  private async acceptPreview(resource: vscode.Uri): Promise<void> {
    let context = this.contextForResource(resource);
    if (!context) {
      return;
    }
    const state = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    if (!state.preview) {
      return;
    }
    context = await this.preparePromptContext(resource);
    if (!context) {
      return;
    }
    const nextState = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    await this.sendPreview(
      context.resource,
      context.controller,
      context.target,
      nextState,
      state.preview
    );
  }

  private async sendPreview(
    resource: vscode.Uri,
    controller: SessionController,
    target: ChatTabTarget,
    state: Awaited<ReturnType<ChatUiState['getComposerStateForIdentity']>>,
    preview: NonNullable<Awaited<ReturnType<ChatUiState['getComposerStateForIdentity']>>['preview']>
  ): Promise<void> {
    const accepted = acceptedSnapshotFromPreview(preview, state.pendingContextItems);
    state.acceptedSendSnapshot = accepted;
    state.preview = undefined;
    state.pendingContextItems = [];
    state.pendingImages = [];
    state.draft = '';
    state.composerResetSeq = (state.composerResetSeq ?? 0) + 1;
    state.focus = 'composer';
    state.recovery = undefined;
    controller.setDraft('');
    await this.uiState.setComposerStateForIdentity(controller, target, state);
    await this.renderResource(resource);
    try {
      if (preview.command === 'prompt') {
        await controller.prompt(preview.rpcMessage, 'prompt', this.asRpcImages(preview.rpcImages));
      } else if (preview.command === 'follow_up') {
        await controller.prompt(
          preview.rpcMessage,
          'followUp',
          this.asRpcImages(preview.rpcImages)
        );
      } else {
        await controller.prompt(preview.rpcMessage, 'steer', this.asRpcImages(preview.rpcImages));
      }
    } catch (error) {
      const current = await this.uiState.getComposerStateForIdentity(controller, target);
      current.acceptedSendSnapshot = {
        ...accepted,
        state: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      current.recovery = {
        kind: 'sendFailure',
        title: 'Draft preserved. Not resent.',
        detail: error instanceof Error ? error.message : String(error),
      };
      await this.uiState.setComposerStateForIdentity(controller, target, current);
      await this.renderResource(resource);
    }
  }

  private asRpcImages(
    images: Array<{ type: 'image'; data: string; mimeType: string }>
  ): JsonObject[] | undefined {
    if (images.length === 0) {
      return undefined;
    }
    return images.map((image) => ({
      type: image.type,
      data: image.data,
      mimeType: image.mimeType,
    }));
  }

  /**
   * Stable identity key for a chat resource. Derived from the parsed target
   * (workspace + session), NOT the raw URI string, so tabs are keyed by what
   * they represent even if the cosmetic URI path/label changes.
   */
  /**
   * A usable fallback target (New Chat for the active/first workspace folder)
   * for when a chat URI cannot be resolved to a known session — so a stale
   * restored tab opens as a fresh chat instead of erroring.
   */
  public fallbackDraftTarget(): ChatTabTarget | undefined {
    const folder = this.registry.getActive()?.folder ?? vscode.workspace.workspaceFolders?.[0];
    return folder
      ? { workspaceFolderUri: folder.uri.toString(), kind: 'workspaceDraft' }
      : undefined;
  }

  private keyFor(resource: vscode.Uri): string {
    const target = parseChatUri(resource);
    return target ? chatTargetSessionKey(target) : resource.toString();
  }

  private contextForResource(resource: vscode.Uri): ChatTabContext | undefined {
    const target = parseChatUri(resource);
    if (!target) {
      return undefined;
    }
    const controller = this.registry.getByFolderUri(target.workspaceFolderUri);
    if (!controller) {
      return undefined;
    }
    return { controller, resource, target };
  }

  private nextSequence(resource: vscode.Uri): number {
    const key = this.keyFor(resource);
    const next = (this.resourceSequence.get(key) ?? 0) + 1;
    this.resourceSequence.set(key, next);
    return next;
  }

  private async onControllerChanged(controller: SessionController): Promise<void> {
    await this.uiState.restoreControllerDraft(controller);
    const currentResource = buildChatUri(currentTargetForController(controller));
    await this.renderResource(currentResource);

    const activeResource = this.activeResourceByWorkspace.get(controller.folder.uri.toString());
    if (activeResource && activeResource !== currentResource.toString()) {
      const parsed = safeParseUri(activeResource);
      if (parsed) {
        await this.renderResource(parsed);
      }
    }
  }

  private async renderResource(
    resource: vscode.Uri,
    options?: { active?: boolean }
  ): Promise<void> {
    const context = this.contextForResource(resource);
    if (!context) {
      return;
    }
    const snapshot = await this.buildSnapshot(context, options?.active ?? false);
    const title = this.titleForContext(context, snapshot);
    const host = this.hosts.get(this.keyFor(resource));
    if (host) {
      await host.postSnapshot(snapshot, title);
    }
    await this.cache.set({
      target: context.target,
      resource: resource.toString(),
      lastKnownTitle: title,
      lastSnapshot: toPersistedChatSnapshot(snapshot),
      lastViewedAt: Date.now(),
      isLiveBound: snapshot.bindingState === 'current',
    });
  }

  private titleForContext(context: ChatTabContext, snapshot: WebviewSnapshot): string {
    const explicitTitle = snapshot.title;
    if (!isDefaultTitle(explicitTitle)) {
      return explicitTitle;
    }
    // A user-set (renamed) session name always wins.
    if (snapshot.sessionName) {
      return snapshot.sessionName;
    }
    // Otherwise, for a history/loaded session, use the first prompt's opening
    // words as the tab name (derived from the FULL transcript, not the window)
    // instead of the opaque .jsonl filename.
    const preview = firstPromptPreview(context.controller.snapshot.messages);
    if (preview) {
      return preview;
    }
    // Nothing loaded yet: prefer a friendly fallback over the raw filename.
    if (context.target.kind === 'sessionFile' && context.target.sessionFile) {
      return `${context.controller.folder.name} Chat`;
    }
    return tabTitleFromTarget(context.target, context.controller.folder.name);
  }

  private revealedMessageCountFor(resource: vscode.Uri): number {
    const key = this.keyFor(resource);
    const stored = this.revealedMessageCounts.get(key);
    return typeof stored === 'number' && stored > 0 ? stored : getSettings().messageWindowSize;
  }

  /** Grow the revealed window for a resource by one page and re-render it. */
  private async revealOlderMessages(resource: vscode.Uri): Promise<void> {
    const key = this.keyFor(resource);
    const step = getSettings().messageWindowSize;
    const context = this.contextForResource(resource);
    const total = context?.controller.snapshot.messages.length ?? 0;
    const current = this.revealedMessageCountFor(resource);
    if (current >= total) {
      return; // nothing older to reveal
    }
    this.revealedMessageCounts.set(key, current + step);
    await this.renderResource(resource);
  }

  private async buildSnapshot(context: ChatTabContext, active: boolean): Promise<WebviewSnapshot> {
    const sequence = this.nextSequence(context.resource);
    const folders = workspaceFolders(this.registry);
    const composer = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    const currentTarget = currentTargetForController(context.controller);
    const isCurrent = sameTarget(currentTarget, context.target);

    if (isCurrent) {
      const snapshot = createWebviewSnapshot(context.controller.snapshot, sequence, {
        uiMode: this.uiState.getMode(),
        composer,
        isTrusted: vscode.workspace.isTrusted,
        folders,
        messageLimit: this.revealedMessageCountFor(context.resource),
      });
      snapshot.bindingState = context.target.kind === 'workspaceDraft' ? 'draft' : 'current';
      return snapshot;
    }

    const cached = this.cache.get(context.resource);
    if (cached?.lastSnapshot) {
      return {
        ...cached.lastSnapshot,
        sequence,
        uiMode: this.uiState.getMode(),
        draft: composer.draft,
        pendingContextItems: composer.pendingContextItems,
        pendingImages: composer.pendingImages.map((item) => ({
          itemId: item.itemId,
          name: item.name,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          width: item.width,
          height: item.height,
          requiresReselect: true,
        })),
        focus: active ? composer.focus : 'none',
        isTrusted: vscode.workspace.isTrusted,
        folders,
        preview: composer.preview,
        acceptedSendSnapshot: composer.acceptedSendSnapshot,
        recovery: composer.recovery,
        bindingState: context.target.kind === 'workspaceDraft' ? 'draft' : 'cached',
      };
    }

    return {
      sequence,
      title: tabTitleFromTarget(context.target, context.controller.folder.name),
      uiMode: this.uiState.getMode(),
      connectionState: context.controller.snapshot.connectionState,
      workspaceFolderName: context.controller.folder.name,
      sessionName:
        context.target.kind === 'sessionFile'
          ? basename(context.target.sessionFile ?? '')
          : context.target.kind === 'sessionId'
            ? context.target.sessionId
            : undefined,
      sessionId: context.target.sessionId,
      sessionFile: context.target.sessionFile,
      isStreaming: false,
      isCompacting: false,
      messageCount: undefined,
      pendingMessageCount: undefined,
      messages: [],
      queue: { steering: [], followUp: [] },
      draft: composer.draft,
      statuses: {},
      widgets: [],
      model: undefined,
      thinkingLevel: undefined,
      pendingContextItems: composer.pendingContextItems,
      pendingImages: composer.pendingImages.map((item) => ({
        itemId: item.itemId,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        width: item.width,
        height: item.height,
        requiresReselect: item.requiresReselect,
      })),
      focus: active ? composer.focus : 'none',
      preview: composer.preview,
      acceptedSendSnapshot: composer.acceptedSendSnapshot,
      recovery: composer.recovery,
      isTrusted: vscode.workspace.isTrusted,
      folders,
      bindingState: context.target.kind === 'workspaceDraft' ? 'draft' : 'cached',
    };
  }

  private async openResource(resource: vscode.Uri): Promise<void> {
    await this.cache.markOpen(resource);
    await vscode.commands.executeCommand('vscode.openWith', resource, CHAT_EDITOR_VIEW_TYPE, {
      preview: false,
      preserveFocus: false,
    });
  }

  private async promoteResource(
    from: vscode.Uri,
    to: vscode.Uri,
    controller: SessionController
  ): Promise<void> {
    const fromState = this.cache.get(from);
    if (fromState) {
      await this.cache.set({
        ...fromState,
        resource: to.toString(),
        target: currentTargetForController(controller),
        lastViewedAt: Date.now(),
      });
      await this.cache.delete(from);
    }
    await this.openResource(to);
    const tab = this.findTab(from);
    if (tab) {
      await vscode.window.tabGroups.close(tab, true);
    }
  }

  private findTab(resource: vscode.Uri): vscode.Tab | undefined {
    const resourceKey = this.keyFor(resource);
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri; viewType?: string };
        if (input.viewType !== CHAT_EDITOR_VIEW_TYPE || !input.uri) {
          continue;
        }
        if (this.keyFor(input.uri) === resourceKey) {
          return tab;
        }
      }
    }
    return undefined;
  }

  private async pickImages(
    controller: SessionController,
    target: ChatTabTarget,
    resource: vscode.Uri
  ): Promise<void> {
    const settings = getSettings();
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
    });
    if (!picked) {
      return;
    }
    const selected: PendingImageItem[] = [];
    for (const uri of picked.slice(0, settings.maxImagesPerPrompt)) {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > settings.maxImageBytes) {
        void vscode.window.showWarningMessage(
          `${uri.path} exceeds the configured image size limit.`
        );
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const lower = uri.path.toLowerCase();
      const extension = Object.keys(IMAGE_MIME_BY_EXTENSION).find((suffix) =>
        lower.endsWith(suffix)
      );
      const mimeType = extension
        ? (IMAGE_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream')
        : 'application/octet-stream';
      const base64 = Buffer.from(bytes).toString('base64');
      selected.push({
        itemId: makeId('image'),
        name: uri.path.split('/').at(-1) ?? uri.path,
        mimeType,
        sizeBytes: stat.size,
        inMemoryBase64: base64,
        previewDataUrl: `data:${mimeType};base64,${base64}`,
      });
    }
    await this.uiState.addImageItemsForIdentity(controller, target, selected);
    await this.renderResource(resource);
  }

  private async captureActiveFile(
    controller: SessionController
  ): Promise<PendingContextItem | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    return this.captureFileLike(controller, editor.document, 'activeFile');
  }

  private async capturePickedFile(
    controller: SessionController
  ): Promise<PendingContextItem | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      title: 'Add a file to the chat',
      defaultUri: controller.folder.uri,
    });
    const uri = picked?.[0];
    if (!uri) {
      return undefined;
    }
    // Containment check first — cheap, avoids any read for out-of-workspace files.
    const workspaceRelativePath = relativeWorkspacePath(controller.folder, uri);
    if (!workspaceRelativePath) {
      void vscode.window.showWarningMessage(
        'Only files inside the active workspace can be attached.'
      );
      return undefined;
    }
    // Size guard BEFORE reading, so a huge/binary file cannot freeze the UI.
    const MAX_ATTACH_BYTES = 512 * 1024;
    let size = 0;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        void vscode.window.showWarningMessage('Pick a file, not a folder.');
        return undefined;
      }
      size = stat.size;
    } catch {
      void vscode.window.showWarningMessage('Could not read that file.');
      return undefined;
    }
    if (size > MAX_ATTACH_BYTES) {
      void vscode.window.showWarningMessage(
        `That file is too large to attach (${Math.round(size / 1024)} KB > ${
          MAX_ATTACH_BYTES / 1024
        } KB). Attach a smaller file or a selection.`
      );
      return undefined;
    }
    // Read bytes directly (fast) instead of opening a full TextDocument, which
    // makes VS Code tokenize/language-process the whole file.
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      void vscode.window.showWarningMessage('Could not read that file.');
      return undefined;
    }
    const content = boundFileContent(text);
    const lineEnd = content.split('\n').length;
    const languageId = basename(uri.fsPath).split('.').pop() || 'plaintext';
    return {
      kind: 'pickedFile',
      itemId: makeId('pickedFile'),
      workspaceFolder: controller.folder.uri.fsPath,
      workspaceRelativePath,
      lineStart: 1,
      lineEnd,
      languageId,
      sanitizedContent: content,
      capturedAt: new Date().toISOString(),
      persistedRef: {
        workspaceRelativePath,
        lineStart: 1,
        lineEnd,
        languageId,
        contentFingerprint: fingerprint(content),
      },
    };
  }

  private async captureFileLike(
    controller: SessionController,
    document: vscode.TextDocument,
    kind: 'activeFile' | 'pickedFile'
  ): Promise<PendingContextItem | undefined> {
    const workspaceRelativePath = relativeWorkspacePath(controller.folder, document.uri);
    if (!workspaceRelativePath) {
      void vscode.window.showWarningMessage(
        'Only files inside the active workspace can be attached.'
      );
      return undefined;
    }
    const content = boundFileContent(document.getText());
    const lineEnd = Math.min(document.lineCount, content.split('\n').length);
    return {
      kind,
      itemId: makeId(kind),
      workspaceFolder: controller.folder.uri.fsPath,
      workspaceRelativePath,
      lineStart: 1,
      lineEnd,
      languageId: document.languageId,
      sanitizedContent: content,
      capturedAt: new Date().toISOString(),
      persistedRef: {
        workspaceRelativePath,
        lineStart: 1,
        lineEnd,
        languageId: document.languageId,
        contentFingerprint: fingerprint(content),
      },
    };
  }

  private async captureSelection(
    controller: SessionController
  ): Promise<PendingContextItem | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return undefined;
    }
    const workspaceRelativePath = relativeWorkspacePath(controller.folder, editor.document.uri);
    if (!workspaceRelativePath) {
      void vscode.window.showWarningMessage(
        'Only selections inside the active workspace can be attached.'
      );
      return undefined;
    }
    const content = boundFileContent(editor.document.getText(editor.selection));
    const lineStart = editor.selection.start.line + 1;
    const lineEnd = editor.selection.end.line + 1;
    return {
      kind: 'selection',
      itemId: makeId('selection'),
      workspaceFolder: controller.folder.uri.fsPath,
      workspaceRelativePath,
      lineStart,
      lineEnd,
      languageId: editor.document.languageId,
      sanitizedContent: content,
      capturedAt: new Date().toISOString(),
      persistedRef: {
        workspaceRelativePath,
        lineStart,
        lineEnd,
        languageId: editor.document.languageId,
        contentFingerprint: fingerprint(content),
      },
    };
  }

  private async captureDiagnostics(
    controller: SessionController
  ): Promise<PendingContextItem | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const workspaceRelativePath = relativeWorkspacePath(controller.folder, editor.document.uri);
    if (!workspaceRelativePath) {
      void vscode.window.showWarningMessage(
        'Only diagnostics inside the active workspace can be attached.'
      );
      return undefined;
    }
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
    const lineStart =
      diagnostics.length > 0
        ? Math.min(...diagnostics.map((item) => item.range.start.line + 1))
        : 1;
    const lineEnd =
      diagnostics.length > 0 ? Math.max(...diagnostics.map((item) => item.range.end.line + 1)) : 1;
    const severity = diagnosticSeverity(diagnostics);
    const content = boundDiagnosticsContent(
      diagnostics.length === 0
        ? 'INFO L1: No diagnostics.'
        : diagnostics
            .slice(0, 100)
            .map((item) => {
              const level =
                item.severity === vscode.DiagnosticSeverity.Error
                  ? 'ERROR'
                  : item.severity === vscode.DiagnosticSeverity.Warning
                    ? 'WARNING'
                    : item.severity === vscode.DiagnosticSeverity.Information
                      ? 'INFO'
                      : 'HINT';
              return `${level} L${item.range.start.line + 1}: ${item.message}`;
            })
            .join('\n')
    );
    return {
      kind: 'diagnostics',
      itemId: makeId('diagnostics'),
      workspaceFolder: controller.folder.uri.fsPath,
      workspaceRelativePath,
      lineStart,
      lineEnd,
      severity,
      issueCount: diagnostics.length,
      sanitizedContent: content,
      capturedAt: new Date().toISOString(),
      persistedRef: {
        workspaceRelativePath,
        lineStart,
        lineEnd,
        severity,
        issueCount: diagnostics.length,
        diagnosticFingerprint: fingerprint(content),
      },
    };
  }
}
