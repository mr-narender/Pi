import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { ensureTrustedForMutation } from '../security/trust';
import { SessionRegistry } from '../sessions/sessionRegistry';
import type { SessionController } from '../sessions/sessionController';
import { createWebviewSnapshot } from './model';
import { parseWebviewMessage } from './messages';
import type { JsonObject } from '../rpc/protocol';
import {
  acceptedSnapshotFromPreview,
  boundDiagnosticsContent,
  boundFileContent,
  buildSendPreview,
  fingerprint,
  type PendingContextItem,
  type PendingImageItem,
} from './composer';
import { ChatUiState } from './composerState';
import { renderChatWebviewHtml } from './html';

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

export class ChatPanelProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private sequence = 0;
  private subscription: vscode.Disposable | undefined;
  private attachmentFileUris = new Set<string>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: SessionRegistry,
    private readonly uiState: ChatUiState
  ) {}

  public async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      await this.bindActiveController();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'piRpc.chat',
      'Current Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.context.extensionUri,
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ],
      }
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.onMessage(message),
      null,
      this.context.subscriptions
    );
    this.panel.onDidDispose(() => {
      this.subscription?.dispose();
      this.subscription = undefined;
      this.panel = undefined;
    });
    await this.bindActiveController();
  }

  public async refresh(): Promise<void> {
    await this.postSnapshot();
  }

  public async focusComposer(): Promise<void> {
    const controller = this.registry.getActive();
    if (!controller) {
      return;
    }
    await this.show();
    await this.uiState.setFocus(controller, 'composer');
    await this.postSnapshot(controller);
  }

  public dispose(): void {
    this.subscription?.dispose();
    this.panel?.dispose();
  }

  private async bindActiveController(): Promise<void> {
    this.subscription?.dispose();
    const controller = await this.registry.getSelectedOrPick();
    if (!controller) {
      return;
    }
    this.registry.setActive(controller);
    this.subscription = controller.onDidChangeState(() => {
      void this.syncControllerState(controller);
    });
    await this.syncControllerState(controller);
  }

  private async syncControllerState(controller: SessionController): Promise<void> {
    await this.uiState.restoreControllerDraft(controller);
    const composer = await this.uiState.getComposerState(controller);
    if (
      controller.snapshot.lastEventType === 'agent_settled' &&
      composer.acceptedSendSnapshot?.state === 'accepted'
    ) {
      composer.acceptedSendSnapshot = undefined;
      composer.recovery = undefined;
      await this.uiState.setComposerState(controller, composer);
    } else if (controller.snapshot.connectionState === 'faulted') {
      if (composer.acceptedSendSnapshot) {
        composer.acceptedSendSnapshot = {
          ...composer.acceptedSendSnapshot,
          state: 'failed',
          errorMessage:
            composer.acceptedSendSnapshot.errorMessage ?? 'Pi disconnected before the run settled.',
        };
        composer.recovery = {
          kind: 'sendFailure',
          title: 'Draft preserved. Not resent.',
          detail: 'Pi disconnected before the last accepted send settled.',
        };
      } else {
        composer.recovery = {
          kind: 'disconnected',
          title: 'Pi disconnected. Your last confirmed chat is safe.',
          detail: 'Restart Pi to reconcile the current workspace.',
        };
      }
      await this.uiState.setComposerState(controller, composer);
    } else if (composer.recovery?.kind === 'disconnected') {
      composer.recovery = undefined;
      await this.uiState.setComposerState(controller, composer);
    }
    await this.postSnapshot(controller);
  }

  private async postSnapshot(controller = this.registry.getActive()): Promise<void> {
    if (!this.panel || !controller) {
      return;
    }
    const composer = await this.uiState.getComposerState(controller);
    const snapshot = createWebviewSnapshot(controller.snapshot, ++this.sequence, {
      uiMode: this.uiState.getMode(),
      composer,
      isTrusted: vscode.workspace.isTrusted,
      folders: this.registry.list().map((item) => ({
        name: item.folder.name,
        uri: item.folder.uri.toString(),
        active: item.folder.uri.toString() === this.registry.getActive()?.folder.uri.toString(),
      })),
    });
    this.attachmentFileUris = new Set(
      snapshot.messages.flatMap((message) =>
        message.attachments
          .map((attachment) => attachment.fileRef?.uri)
          .filter((uri): uri is string => typeof uri === 'string')
      )
    );
    this.panel.title = snapshot.sessionName ?? snapshot.workspaceFolderName ?? 'Current Chat';
    await this.panel.webview.postMessage({ type: 'snapshot', snapshot });
  }

  private async onMessage(message: unknown): Promise<void> {
    const controller = this.registry.getActive();
    const parsed = parseWebviewMessage(message);
    if (!controller || !parsed) {
      return;
    }
    switch (parsed.type) {
      case 'requestSend':
        await this.handleRequestSend(controller, parsed.command);
        return;
      case 'acceptPreview':
        await this.acceptPreview(controller);
        return;
      case 'cancelPreview': {
        const state = await this.uiState.getComposerState(controller);
        state.preview = undefined;
        state.focus = 'composer';
        await this.uiState.setComposerState(controller, state);
        await this.postSnapshot(controller);
        return;
      }
      case 'copyAcceptedSnapshot':
        await this.uiState.copyAcceptedSnapshotToComposer(controller);
        await this.postSnapshot(controller);
        return;
      case 'sendAcceptedSnapshotAgain': {
        const state = await this.uiState.getComposerState(controller);
        const command = state.acceptedSendSnapshot?.command;
        await this.uiState.copyAcceptedSnapshotToComposer(controller);
        if (command) {
          await this.handleRequestSend(controller, command);
        } else {
          await this.postSnapshot(controller);
        }
        return;
      }
      case 'abort':
        await controller.abort();
        return;
      case 'setDraft':
        controller.setDraft(parsed.text);
        await this.uiState.updateDraft(controller, parsed.text);
        return;
      case 'setFocus':
        await this.uiState.setFocus(controller, parsed.focus);
        return;
      case 'executeCommand':
        await vscode.commands.executeCommand(parsed.command, parsed.argument);
        return;
      case 'pickImages':
        await this.pickImages(controller);
        return;
      case 'clearAttachments':
        await this.uiState.clearAttachments(controller);
        await this.postSnapshot(controller);
        return;
      case 'appendActiveFile': {
        const item = await this.captureActiveFile(controller);
        if (item) {
          await this.uiState.addContextItem(controller, item);
          await this.postSnapshot(controller);
        }
        return;
      }
      case 'appendSelection': {
        const item = await this.captureSelection(controller);
        if (item) {
          await this.uiState.addContextItem(controller, item);
          await this.postSnapshot(controller);
        }
        return;
      }
      case 'appendDiagnostics': {
        const item = await this.captureDiagnostics(controller);
        if (item) {
          await this.uiState.addContextItem(controller, item);
          await this.postSnapshot(controller);
        }
        return;
      }
      case 'appendPickedFile': {
        const item = await this.capturePickedFile(controller);
        if (item) {
          await this.uiState.addContextItem(controller, item);
          await this.postSnapshot(controller);
        }
        return;
      }
      case 'removeContextItem':
        await this.uiState.removeContextItem(controller, parsed.itemId);
        await this.postSnapshot(controller);
        return;
      case 'removeImageItem':
        await this.uiState.removeImageItem(controller, parsed.itemId);
        await this.postSnapshot(controller);
        return;
      case 'openAttachment':
        if (!this.attachmentFileUris.has(parsed.uri)) {
          return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(parsed.uri, true));
        return;
      case 'switchFolder': {
        const selected = this.registry.setActive(parsed.folderUri);
        if (selected) {
          await this.bindActiveController();
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleRequestSend(
    controller: SessionController,
    command: 'prompt' | 'follow_up' | 'steer'
  ): Promise<void> {
    ensureTrustedForMutation();
    const state = await this.uiState.getComposerState(controller);
    state.recovery = undefined;
    state.preview = undefined;
    try {
      const preview = buildSendPreview(command, state);
      if (state.pendingContextItems.length > 0 || state.pendingImages.length > 0) {
        state.preview = preview;
        state.focus = 'preview';
        await this.uiState.setComposerState(controller, state);
        await this.postSnapshot(controller);
        return;
      }
      await this.sendPreview(controller, state, preview);
    } catch (error) {
      state.recovery = {
        kind: 'preflightError',
        title: 'Attachments need attention.',
        detail: error instanceof Error ? error.message : String(error),
      };
      await this.uiState.setComposerState(controller, state);
      await this.postSnapshot(controller);
    }
  }

  private async acceptPreview(controller: SessionController): Promise<void> {
    const state = await this.uiState.getComposerState(controller);
    if (!state.preview) {
      return;
    }
    await this.sendPreview(controller, state, state.preview);
  }

  private async sendPreview(
    controller: SessionController,
    state: Awaited<ReturnType<ChatUiState['getComposerState']>>,
    preview: NonNullable<Awaited<ReturnType<ChatUiState['getComposerState']>>['preview']>
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
    await this.uiState.setComposerState(controller, state);
    await this.postSnapshot(controller);
    try {
      if (controller.snapshot.connectionState === 'stopped') {
        try {
          await controller.start();
        } catch (error) {
          const current = await this.uiState.getComposerState(controller);
          current.acceptedSendSnapshot = undefined;
          current.pendingContextItems = accepted.contextItems;
          current.pendingImages = preview.imageItems.map((item, index) => ({
            itemId: item.itemId,
            name: item.name,
            mimeType: item.mimeType,
            sizeBytes: item.sizeBytes,
            inMemoryBase64: preview.rpcImages[index]?.data,
            previewDataUrl: preview.rpcImages[index]
              ? `data:${preview.rpcImages[index]!.mimeType};base64,${preview.rpcImages[index]!.data}`
              : undefined,
            requiresReselect: item.requiresReselect,
          }));
          current.draft = accepted.draft;
          current.recovery = {
            kind: 'startFailure',
            title: 'Pi could not start.',
            detail: error instanceof Error ? error.message : String(error),
          };
          await this.uiState.setComposerState(controller, current);
          controller.setDraft(current.draft);
          await this.postSnapshot(controller);
          return;
        }
      }
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
      const current = await this.uiState.getComposerState(controller);
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
      await this.uiState.setComposerState(controller, current);
      await this.postSnapshot(controller);
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

  private async pickImages(controller: SessionController): Promise<void> {
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
    await this.uiState.addImageItems(controller, selected);
    await this.postSnapshot(controller);
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

  private renderHtml(webview: vscode.Webview): string {
    return renderChatWebviewHtml(this.context.extensionUri, webview, 'Current Chat');
  }
}
