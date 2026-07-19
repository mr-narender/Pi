import * as vscode from 'vscode';
import { basename } from 'node:path';
import { getSettings } from '../config/settings';
import { ensureTrustedForMutation } from '../security/trust';
import { SessionRegistry } from '../sessions/sessionRegistry';
import type { SessionController } from '../sessions/sessionController';
import { createWebviewSnapshot } from '../webview/model';
import { parseWebviewMessage } from '../webview/messages';
import {
  acceptedSnapshotFromPreview,
  boundDiagnosticsContent,
  boundFileContent,
  buildSendPreview,
  fingerprint,
  type PendingContextItem,
  type PendingImageItem,
} from '../webview/composer';
import { ChatUiState } from '../webview/composerState';
import type { JsonObject } from '../rpc/protocol';
import type { WebviewSnapshot } from '../state/types';
import { renderChatWebviewHtml } from '../webview/html';
import {
  CHAT_EDITOR_VIEW_TYPE,
  buildChatUri,
  chatTargetSessionKey,
  parseChatUri,
  tabTitleFromTarget,
  type ChatTabTarget,
} from './uri';
import { ChatTabStateCache, toPersistedChatSnapshot } from './sessionCache';
import type { ChatEditorDocument } from './document';

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
  return !value || value === 'Pi RPC';
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
    await this.panel.webview.postMessage({ type: 'snapshot', snapshot });
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
  private readonly controllerSubscriptions: vscode.Disposable[] = [];

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: SessionRegistry,
    private readonly uiState: ChatUiState
  ) {
    this.cache = new ChatTabStateCache(context);
    for (const controller of registry.list()) {
      this.trackController(controller);
    }
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
    const key = document.uri.toString();
    this.hosts.get(key)?.dispose();
    const host = new ChatEditorHost(this.context.extensionUri, document, panel, this);
    this.hosts.set(key, host);
    await this.cache.markOpen(document.uri);
    await this.renderResource(document.uri, { active: panel.active });
    if (panel.active) {
      await this.activateResource(document.uri, { startIfStopped: false });
    }
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

    if (options?.startIfStopped && context.controller.snapshot.connectionState === 'stopped') {
      await context.controller.start(
        context.target.kind === 'sessionFile' ? context.target.sessionFile : undefined
      );
      await context.controller.reconcile();
    }

    if (
      (context.controller.snapshot.connectionState === 'ready' ||
        context.controller.snapshot.connectionState === 'busy') &&
      context.target.kind === 'sessionFile' &&
      context.target.sessionFile &&
      !sameTarget(currentTargetForController(context.controller), context.target)
    ) {
      await this.uiState.captureControllerDraft(context.controller);
      await context.controller.switchSession(context.target.sessionFile);
      await this.uiState.restoreControllerDraft(context.controller);
    }

    await this.renderResource(resource, { active: true });
    if (previousResource && previousResource !== resource.toString()) {
      await this.renderResource(vscode.Uri.parse(previousResource));
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
    const nextTarget = currentTargetForController(current.controller);
    await this.uiState.setComposerStateForIdentity(current.controller, nextTarget, draftState);
    await this.uiState.clearComposerStateForIdentity(current.controller, current.target);
    const nextResource = buildChatUri(nextTarget);
    await this.promoteResource(resource, nextResource, current.controller);
    return this.activateResource(nextResource, { startIfStopped: false });
  }

  public async openForSessionFile(
    controller: SessionController,
    sessionFile: string,
    options?: { focusComposer?: boolean }
  ): Promise<vscode.Uri> {
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
    const key = host.resource.toString();
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
          context.controller.setDraft(parsed.text);
        }
        return;
      }
      case 'setFocus':
        await this.uiState.setFocusForIdentity(context.controller, context.target, parsed.focus);
        return;
      case 'executeCommand':
        await vscode.commands.executeCommand(parsed.command, parsed.argument);
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
    const key = resource.toString();
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
      await this.renderResource(vscode.Uri.parse(activeResource));
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
    const host = this.hosts.get(resource.toString());
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
    if (snapshot.sessionName) {
      return snapshot.sessionName;
    }
    if (context.target.kind === 'sessionFile' && context.target.sessionFile) {
      return basename(context.target.sessionFile);
    }
    return tabTitleFromTarget(context.target, context.controller.folder.name);
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
    const resourceKey = resource.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri; viewType?: string };
        if (input.viewType === CHAT_EDITOR_VIEW_TYPE && input.uri?.toString() === resourceKey) {
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
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false });
    if (!picked?.[0]) {
      return undefined;
    }
    const document = await vscode.workspace.openTextDocument(picked[0]);
    return this.captureFileLike(controller, document, 'pickedFile');
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
