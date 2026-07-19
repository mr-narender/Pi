import * as vscode from 'vscode';
import {
  boundDiagnosticsContent,
  boundFileContent,
  canonicalSessionKey,
  chipPrivacyLabel,
  cloneComposerState,
  createEmptyComposerState,
  fingerprint,
  type ChatUiMode,
  type ComposerSessionState,
  type PendingContextItem,
  type PendingImageItem,
  type PersistedComposerSessionState,
  persistableComposerState,
  type RecoveryState,
  summarizeChip,
} from './composer';
import type { SessionController } from '../sessions/sessionController';
import type { ChatTabTarget } from '../editorTabs/uri';

const STORAGE_KEY = 'piRpc.composerState.v1';
const UI_MODE_KEY = 'piRpc.uiMode';

function workspaceFolderUri(controller: SessionController): string {
  return controller.folder.uri.toString();
}

function currentIdentity(controller: SessionController): ChatTabTarget {
  return {
    workspaceFolderUri: workspaceFolderUri(controller),
    kind:
      typeof controller.snapshot.state.sessionFile === 'string'
        ? 'sessionFile'
        : typeof controller.snapshot.state.sessionId === 'string'
          ? 'sessionId'
          : 'workspaceDraft',
    sessionFile:
      typeof controller.snapshot.state.sessionFile === 'string'
        ? controller.snapshot.state.sessionFile
        : undefined,
    sessionId:
      typeof controller.snapshot.state.sessionId === 'string'
        ? controller.snapshot.state.sessionId
        : undefined,
  };
}

function sessionStateKeyForIdentity(identity: ChatTabTarget): string {
  return canonicalSessionKey(identity.workspaceFolderUri, identity.sessionFile, identity.sessionId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ChatUiState implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly composerStates = new Map<string, ComposerSessionState>();
  private readonly loadedKeys = new Set<string>();

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  public dispose(): void {
    this.emitter.dispose();
    this.composerStates.clear();
    this.loadedKeys.clear();
  }

  public getMode(): ChatUiMode {
    const stored = this.context.globalState.get<ChatUiMode | undefined>(UI_MODE_KEY);
    if (stored === 'simple' || stored === 'advanced') {
      return stored;
    }
    const configured = vscode.workspace.getConfiguration('piRpc').get<string>('defaultViewMode');
    return configured === 'advanced' ? 'advanced' : 'simple';
  }

  public async setMode(mode: ChatUiMode): Promise<void> {
    await this.context.globalState.update(UI_MODE_KEY, mode);
    this.emitter.fire();
  }

  public async toggleMode(): Promise<ChatUiMode> {
    const next = this.getMode() === 'advanced' ? 'simple' : 'advanced';
    await this.setMode(next);
    return next;
  }

  public async getComposerState(controller: SessionController): Promise<ComposerSessionState> {
    return this.getComposerStateForIdentity(controller, currentIdentity(controller));
  }

  public async getComposerStateForIdentity(
    controller: SessionController,
    identity: ChatTabTarget
  ): Promise<ComposerSessionState> {
    const key = sessionStateKeyForIdentity(identity);
    if (!this.loadedKeys.has(key)) {
      const persisted = this.readPersistedState()[key];
      this.composerStates.set(key, await this.restorePersistedState(controller, persisted));
      this.loadedKeys.add(key);
    }
    const existing = this.composerStates.get(key) ?? createEmptyComposerState();
    const validated = await this.validateContextItems(controller, existing);
    this.composerStates.set(key, validated);
    return cloneComposerState(validated);
  }

  public async setComposerState(
    controller: SessionController,
    state: ComposerSessionState
  ): Promise<void> {
    await this.setComposerStateForIdentity(controller, currentIdentity(controller), state);
  }

  public async setComposerStateForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    state: ComposerSessionState
  ): Promise<void> {
    const key = sessionStateKeyForIdentity(identity);
    this.composerStates.set(key, cloneComposerState(state));
    await this.persist();
    if (sessionStateKeyForIdentity(currentIdentity(controller)) === key) {
      controller.setDraft(state.draft);
    }
    this.emitter.fire();
  }

  public async clearComposerStateForIdentity(
    _controller: SessionController,
    identity: ChatTabTarget
  ): Promise<void> {
    const key = sessionStateKeyForIdentity(identity);
    this.composerStates.delete(key);
    this.loadedKeys.delete(key);
    const current = this.readPersistedState();
    delete current[key];
    await this.context.workspaceState.update(STORAGE_KEY, current);
    this.emitter.fire();
  }

  public async updateDraft(controller: SessionController, draft: string): Promise<void> {
    await this.updateDraftForIdentity(controller, currentIdentity(controller), draft);
  }

  public async updateDraftForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    draft: string
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.draft = draft;
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async restoreControllerDraft(controller: SessionController): Promise<void> {
    await this.restoreControllerDraftForIdentity(controller, currentIdentity(controller));
  }

  public async restoreControllerDraftForIdentity(
    controller: SessionController,
    identity: ChatTabTarget
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    if (controller.snapshot.draft !== state.draft) {
      controller.setDraft(state.draft);
    }
  }

  public async captureControllerDraft(controller: SessionController): Promise<void> {
    await this.captureControllerDraftForIdentity(controller, currentIdentity(controller));
  }

  public async captureControllerDraftForIdentity(
    controller: SessionController,
    identity: ChatTabTarget
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    if (state.draft !== controller.snapshot.draft) {
      state.draft = controller.snapshot.draft;
      await this.setComposerStateForIdentity(controller, identity, state);
    }
  }

  public async removeContextItem(controller: SessionController, itemId: string): Promise<void> {
    await this.removeContextItemForIdentity(controller, currentIdentity(controller), itemId);
  }

  public async removeContextItemForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    itemId: string
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.pendingContextItems = state.pendingContextItems.filter((item) => item.itemId !== itemId);
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async removeImageItem(controller: SessionController, itemId: string): Promise<void> {
    await this.removeImageItemForIdentity(controller, currentIdentity(controller), itemId);
  }

  public async removeImageItemForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    itemId: string
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.pendingImages = state.pendingImages.filter((item) => item.itemId !== itemId);
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async clearAttachments(controller: SessionController): Promise<void> {
    await this.clearAttachmentsForIdentity(controller, currentIdentity(controller));
  }

  public async clearAttachmentsForIdentity(
    controller: SessionController,
    identity: ChatTabTarget
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.pendingContextItems = [];
    state.pendingImages = [];
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async setRecovery(
    controller: SessionController,
    recovery: RecoveryState | undefined
  ): Promise<void> {
    await this.setRecoveryForIdentity(controller, currentIdentity(controller), recovery);
  }

  public async setRecoveryForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    recovery: RecoveryState | undefined
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.recovery = recovery;
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async setFocus(
    controller: SessionController,
    focus: ComposerSessionState['focus']
  ): Promise<void> {
    await this.setFocusForIdentity(controller, currentIdentity(controller), focus);
  }

  public async setFocusForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    focus: ComposerSessionState['focus']
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.focus = focus;
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async addContextItem(
    controller: SessionController,
    item: PendingContextItem
  ): Promise<void> {
    await this.addContextItemForIdentity(controller, currentIdentity(controller), item);
  }

  public async addContextItemForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    item: PendingContextItem
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.pendingContextItems = [...state.pendingContextItems, item];
    state.focus = 'contextChip';
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async addImageItems(
    controller: SessionController,
    items: PendingImageItem[]
  ): Promise<void> {
    await this.addImageItemsForIdentity(controller, currentIdentity(controller), items);
  }

  public async addImageItemsForIdentity(
    controller: SessionController,
    identity: ChatTabTarget,
    items: PendingImageItem[]
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    state.pendingImages = [...state.pendingImages, ...items];
    state.focus = 'imageChip';
    await this.setComposerStateForIdentity(controller, identity, state);
  }

  public async copyAcceptedSnapshotToComposer(controller: SessionController): Promise<void> {
    await this.copyAcceptedSnapshotToComposerForIdentity(controller, currentIdentity(controller));
  }

  public async copyAcceptedSnapshotToComposerForIdentity(
    controller: SessionController,
    identity: ChatTabTarget
  ): Promise<void> {
    const state = await this.getComposerStateForIdentity(controller, identity);
    const snapshot = state.acceptedSendSnapshot;
    if (!snapshot) {
      return;
    }
    state.draft = snapshot.draft;
    state.pendingContextItems = await this.revalidateRestoredContextItems(
      controller,
      snapshot.contextItems
    );
    state.pendingImages = snapshot.imageItems.map((item, index) => {
      const image = snapshot.rpcImages[index];
      return {
        itemId: item.itemId,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        inMemoryBase64: image?.data,
        previewDataUrl: image ? `data:${image.mimeType};base64,${image.data}` : undefined,
        requiresReselect: !image?.data || item.requiresReselect,
      } satisfies PendingImageItem;
    });
    state.recovery = undefined;
    state.preview = undefined;
    state.focus = 'composer';
    await this.setComposerStateForIdentity(controller, identity, state);
    if (
      sessionStateKeyForIdentity(currentIdentity(controller)) ===
      sessionStateKeyForIdentity(identity)
    ) {
      controller.setDraft(state.draft);
    }
  }

  public async invalidateForWorkspaceFolder(folderUri: string): Promise<void> {
    const next = Object.fromEntries(
      Object.entries(this.readPersistedState()).filter(([key]) => !key.startsWith(`${folderUri}::`))
    );
    await this.context.workspaceState.update(STORAGE_KEY, next);
    for (const key of [...this.composerStates.keys()]) {
      if (key.startsWith(`${folderUri}::`)) {
        this.composerStates.delete(key);
        this.loadedKeys.delete(key);
      }
    }
  }

  public currentSessionKey(controller: SessionController): string {
    return sessionStateKeyForIdentity(currentIdentity(controller));
  }

  public describeContextItem(item: PendingContextItem): {
    label: string;
    privacy: string;
    preview: string;
    meta: string;
  } {
    const content = item.sanitizedContent;
    const lines = content ? content.split('\n').length : 0;
    const size = content.length;
    const meta =
      item.kind === 'diagnostics'
        ? `${item.workspaceRelativePath} · ${item.issueCount} issues`
        : `${item.workspaceRelativePath} · ${lines} lines · ${size} chars`;
    return {
      label: summarizeChip(item),
      privacy: chipPrivacyLabel(item),
      preview: content,
      meta,
    };
  }

  private readPersistedState(): Record<string, PersistedComposerSessionState> {
    const value = this.context.workspaceState.get<Record<string, PersistedComposerSessionState>>(
      STORAGE_KEY,
      {}
    );
    return asRecord(value) ? (value as Record<string, PersistedComposerSessionState>) : {};
  }

  private async persist(): Promise<void> {
    const current = this.readPersistedState();
    for (const [key, value] of this.composerStates) {
      current[key] = persistableComposerState(value);
    }
    await this.context.workspaceState.update(STORAGE_KEY, current);
  }

  private async restorePersistedState(
    controller: SessionController,
    persisted: PersistedComposerSessionState | undefined
  ): Promise<ComposerSessionState> {
    if (!persisted) {
      return createEmptyComposerState();
    }
    return {
      draft: persisted.draft ?? '',
      pendingContextItems: await Promise.all(
        (persisted.pendingContextItems ?? []).map((item) =>
          this.restorePersistedContextItem(controller, item as PendingContextItem)
        )
      ),
      pendingImages: (persisted.pendingImages ?? []).map((item) => ({
        itemId: item.itemId,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        width: item.width,
        height: item.height,
        requiresReselect: true,
      })),
      focus: persisted.focus ?? 'composer',
    };
  }

  private async restorePersistedContextItem(
    controller: SessionController,
    item: PendingContextItem
  ): Promise<PendingContextItem> {
    return this.revalidateContextItem(controller, {
      ...item,
      sanitizedContent: '',
      stale: true,
      staleReason: 'Refresh required',
    });
  }

  private async validateContextItems(
    controller: SessionController,
    state: ComposerSessionState
  ): Promise<ComposerSessionState> {
    const pendingContextItems = await Promise.all(
      state.pendingContextItems.map((item) => this.revalidateContextItem(controller, item))
    );
    return { ...state, pendingContextItems };
  }

  private async revalidateRestoredContextItems(
    controller: SessionController,
    items: PendingContextItem[]
  ): Promise<PendingContextItem[]> {
    const next = await Promise.all(
      items.map((item) => this.revalidateContextItem(controller, item))
    );
    return next.filter((item) => !item.stale);
  }

  private async revalidateContextItem(
    controller: SessionController,
    item: PendingContextItem
  ): Promise<PendingContextItem> {
    if (!vscode.workspace.isTrusted) {
      return {
        ...item,
        stale: true,
        staleReason: 'Trust this workspace to refresh this attachment.',
      };
    }
    const folderPath = controller.folder.uri.fsPath;
    const relativePath = item.workspaceRelativePath;
    const target = vscode.Uri.joinPath(controller.folder.uri, relativePath);
    try {
      if (item.kind === 'diagnostics') {
        const diagnostics = vscode.languages.getDiagnostics(target);
        const lines = diagnostics
          .map((diagnostic) => {
            const severity =
              diagnostic.severity === vscode.DiagnosticSeverity.Error
                ? 'ERROR'
                : diagnostic.severity === vscode.DiagnosticSeverity.Warning
                  ? 'WARNING'
                  : diagnostic.severity === vscode.DiagnosticSeverity.Information
                    ? 'INFO'
                    : 'HINT';
            return `${severity} L${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
          })
          .slice(0, item.persistedRef.issueCount || 100);
        const content = boundDiagnosticsContent(lines.join('\n'));
        const fp = fingerprint(content);
        if (
          fp !== item.persistedRef.diagnosticFingerprint ||
          item.persistedRef.workspaceRelativePath !== relativePath
        ) {
          return { ...item, stale: true, staleReason: 'Expired' };
        }
        return { ...item, sanitizedContent: content, stale: false, staleReason: undefined };
      }

      const document = await vscode.workspace.openTextDocument(target);
      const start = Math.max(0, item.persistedRef.lineStart - 1);
      const end = Math.min(document.lineCount, item.persistedRef.lineEnd);
      if (start >= end) {
        return { ...item, stale: true, staleReason: 'Expired' };
      }
      const range = new vscode.Range(start, 0, end - 1, document.lineAt(end - 1).text.length);
      const content = boundFileContent(document.getText(range));
      const fp = fingerprint(content);
      if (
        fp !== item.persistedRef.contentFingerprint ||
        item.persistedRef.workspaceRelativePath !== relativePath ||
        ('languageId' in item.persistedRef && item.persistedRef.languageId !== document.languageId)
      ) {
        return { ...item, stale: true, staleReason: 'Expired' };
      }
      return {
        ...item,
        workspaceFolder: folderPath,
        sanitizedContent: content,
        languageId: document.languageId,
        stale: false,
        staleReason: undefined,
      };
    } catch {
      return { ...item, stale: true, staleReason: 'Expired' };
    }
  }
}
