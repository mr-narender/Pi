import * as vscode from 'vscode';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import { getSettings, tabTitleSettings } from '../config/settings';
import { pickChatModel } from '../commands/modelPicker';
import { AgentFollowService } from '../live/agentFollow';
import { sharedPiHostActiveSessionCount } from '../process/sharedPiHost';
import { RemoteSharingService } from '../remote/sharingService';
import { ensureTrustedForMutation } from '../security/trust';
import { SessionRegistry } from '../sessions/sessionRegistry';
import type { SessionController } from '../sessions/sessionController';
import type { DiagnosticsLogger } from '../diagnostics/logger';
import { createWebviewSnapshot, firstPromptPreview } from '../webview/model';
import type { TurnReview } from '../review/turnReview';
import { SessionIndex } from './sessionIndex';
import { notifier } from '../ui/notifier';
import { parseWebviewMessage } from '../webview/messages';
import {
  type AcceptedSendSnapshot,
  type PendingImageItem,
  acceptedSnapshotFromPreview,
  beginSend,
  createEmptyComposerState,
  restoreEditableStateFromAcceptedSnapshot,
} from '../webview/composer';
import {
  IMAGE_MIME_BY_EXTENSION,
  makeId,
  relativeWorkspacePath,
  captureActiveFile,
  capturePickedFile,
  captureFileLike,
  captureSelection,
  captureDiagnostics,
} from './attachmentCapture';
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

// The chat-header workspace dropdown must list REAL workspace folders (its
// purpose is multi-root switching), not registry controllers — the per-tab model
// has one controller per OPEN CHAT, which produced N duplicate entries and made
// the dropdown appear in single-folder windows. The webview hides it unless
// there is more than one entry.
function workspaceFolders(chatFolderUri?: string) {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    uri: folder.uri.toString(),
    active: folder.uri.toString() === chatFolderUri,
  }));
  // A foreign-project chat ("Other projects") runs outside the workspace — show
  // its real folder as the active entry so the header stays truthful.
  if (chatFolderUri && !folders.some((folder) => folder.uri === chatFolderUri)) {
    try {
      const parsed = vscode.Uri.parse(chatFolderUri, true);
      folders.push({
        name: basename(parsed.fsPath) || parsed.fsPath,
        uri: chatFolderUri,
        active: true,
      });
    } catch {
      /* unparseable — skip */
    }
  }
  return folders;
}

// Commands the chat webview may invoke via the generic executeCommand message.
// Keep in sync with data-command usages in render.ts / chat.ts — nothing
// else. (The Agentic Mode list's own ⋯ menu moved to a native view/title
// submenu — package.json's piRpc.chatListMore — so it no longer needs this.)
const WEBVIEW_COMMAND_ALLOWLIST = new Set<string>([
  'piRpc.togglePermissionMode',
  'piRpcInternal.retryWithModel',
  'piRpc.abort',
  'piRpc.commandPalette',
  'piRpc.remote.stop',
  'piRpc.chatSettings',
  'piRpc.reviewLastTurn',
  'piRpc.showChatVersions',
  'piRpc.exportHtml',
  'piRpc.showPiCommands',
  'piRpc.switchSession',
  'piRpcInternal.restart',
  'piRpcInternal.retryLast',
  'piRpcInternal.showLogs',
  'piRpcInternal.start',
  'piRpc.manageExtensions',
  'piRpc.manageSkills',
  'piRpc.managePrompts',
  'piRpc.manageAgentInstructions',
]);

/** Common surface for chat hosts: editor-tab panels AND the sidebar view.
 * tabManager treats both identically; only construction differs. */
export interface ChatHost extends vscode.Disposable {
  readonly resource: vscode.Uri;
  readonly panel: {
    readonly webview: vscode.Webview;
    readonly visible: boolean;
    readonly active: boolean;
    readonly viewColumn?: vscode.ViewColumn;
    title: string;
    reveal(viewColumn?: vscode.ViewColumn, preserveFocus?: boolean): void;
  };
  postSnapshot(snapshot: WebviewSnapshot, title: string): Promise<void>;
  post(message: unknown): void;
  hasAttachment(uri: string): boolean;
  reveal(): void;
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
    // Chat tabs get the Pi icon (custom editors have no file-icon-theme icon).
    // tab-icon.svg is the brand-orange variant — panel.iconPath renders SVGs
    // as-is (no theme masking), so the currentColor activity-bar mark was
    // near-invisible on dark themes.
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'tab-icon.svg');
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [extensionUri, vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    this.panel.webview.html = renderChatWebviewHtml(
      extensionUri,
      this.panel.webview,
      'Pi Chat',
      __PI_BUILD__
    );
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
    this.panel.title = formatTabTitle(title);
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

  /** Post an auxiliary (non-snapshot) message to the webview. */
  public post(message: unknown): void {
    void this.panel.webview.postMessage(message);
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

/** The π sidebar chat: same webview, same pipeline, docked in the activity
 * bar — the editor area stays free for real files (Zed layout). Binds to a
 * stable synthetic resource so its session persists across reloads. */
class SidebarChatHost implements ChatHost {
  private readonly disposables: vscode.Disposable[] = [];
  private attachmentFileUris = new Set<string>();
  public readonly panel: ChatHost['panel'];

  public constructor(
    extensionUri: vscode.Uri,
    private readonly view: vscode.WebviewView,
    private readonly manager: ChatTabManager,
    public readonly resource: vscode.Uri
  ) {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [extensionUri, vscode.Uri.joinPath(extensionUri, 'dist')],
    };
    view.webview.html = renderChatWebviewHtml(extensionUri, view.webview, 'Pi Chat', __PI_BUILD__);
    const self = this;
    this.panel = {
      webview: view.webview,
      get visible() {
        return self.view.visible;
      },
      get active() {
        return self.view.visible;
      },
      viewColumn: undefined,
      title: '',
      reveal: () => self.view.show?.(true),
    };
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => void manager.onMessage(this, message)),
      view.onDidDispose(() => void manager.onHostDisposed(this)),
      view.onDidChangeVisibility(() => void manager.onHostViewStateChanged(this, view.visible))
    );
  }

  public async postSnapshot(snapshot: WebviewSnapshot, title: string): Promise<void> {
    this.view.description = title.replace(/\u2007+$/g, '').trim();
    this.attachmentFileUris = new Set(
      snapshot.messages.flatMap((message) =>
        message.attachments
          .map((attachment) => attachment.fileRef?.uri)
          .filter((uri): uri is string => typeof uri === 'string')
      )
    );
    void this.view.webview.postMessage({ type: 'snapshot', snapshot });
  }

  public post(message: unknown): void {
    void this.view.webview.postMessage(message);
  }

  public hasAttachment(uri: string): boolean {
    return this.attachmentFileUris.has(uri);
  }

  public reveal(): void {
    this.view.show?.(true);
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
  private readonly follow = new AgentFollowService();

  private readonly cache: ChatTabStateCache;
  private readonly hosts = new Map<string, ChatHost>();
  // Agentic Mode's "Open Chat List" needs to know when a chat opens/closes,
  // distinct from any single controller's state changing — nothing existing
  // covered "the SET of open chats changed."
  private readonly openChatsEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeOpenChats: vscode.Event<void> = this.openChatsEmitter.event;
  /** Remote chat sharing (pairing panel / phone mirror) — own feature surface,
   * lives in its own service (A2 of the de-bloat plan). Only needs read
   * access to hosts/keyFor/renderResource/activateResource/getActiveContext,
   * which ChatTabManager legitimately owns and hands over here. */
  public readonly remoteSharing: RemoteSharingService;
  private readonly resourceSequence = new Map<string, number>();
  private readonly activeResourceByWorkspace = new Map<string, string>();
  // Completion-notification bookkeeping (busy->ready transition per controller).
  // Keyed by CONTROLLER (not folder): with parallel per-tab controllers, several
  // chats share a folder and folder-keyed busy tracking collides across them.
  private readonly lastConnState = new WeakMap<SessionController, string>();
  private readonly busySince = new WeakMap<SessionController, number>();
  private turnReview: TurnReview | undefined;

  public setTurnReview(review: TurnReview): void {
    this.turnReview = review;
  }
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
    this.remoteSharing = new RemoteSharingService({
      hosts: () => this.hosts.values(),
      keyFor: (resource) => this.keyFor(resource),
      renderResource: (resource, options) => this.renderResource(resource, options),
      activateResource: (resource, options) => this.activateResource(resource, options),
      getActiveContext: () => this.getActiveContext(),
    });
    this.sessions = new SessionIndex(context.workspaceState);
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
    // Idle session reaper: hidden, idle chats release their runtime session after
    // piRpc.idleSessionMinutes (tab + transcript stay; focus restarts instantly).
    this.reapTimer = setInterval(() => void this.reapIdleSessions(), 5 * 60_000);
    this.reapTimer.unref?.();
  }

  // WeakMaps: closed chats must not pin their dead controllers (and their full
  // message state) in memory for the window's lifetime (#1, review round 2).
  private readonly lastActivityAt = new WeakMap<SessionController, number>();
  private reapTimer: ReturnType<typeof setInterval> | undefined;
  public readonly contextPercent = new WeakMap<SessionController, number>();
  private readonly contextWarnedAt = new WeakMap<SessionController, number>();

  // After each turn, record context usage; warn once per 10min above 85% so a
  // chat never gets surprise-compacted mid-task.
  private async checkContextPressure(controller: SessionController): Promise<void> {
    try {
      const stats = await controller.showSessionStats();
      const usage = stats?.contextUsage as { percent?: number | null } | undefined;
      const percent = typeof usage?.percent === 'number' ? usage.percent : undefined;
      if (percent === undefined) {
        return;
      }
      this.contextPercent.set(controller, percent);
      if (percent >= 85) {
        const last = this.contextWarnedAt.get(controller) ?? 0;
        if (Date.now() - last > 10 * 60_000) {
          this.contextWarnedAt.set(controller, Date.now());
          const name = controller.snapshot.state.sessionName;
          notifier.notify({
            kind: 'context',
            title: typeof name === 'string' && name ? `“${name}”` : 'a background chat',
            detail: `${Math.round(percent)}%`,
            open: () => this.revealController(controller),
          });
        }
      }
    } catch {
      /* stats unavailable — skip */
    }
  }

  private async reapIdleSessions(): Promise<void> {
    const minutes = getSettings().idleSessionMinutes;
    if (minutes <= 0) {
      return;
    }
    const cutoff = Date.now() - minutes * 60_000;
    for (const host of this.hosts.values()) {
      if (host.panel.visible) {
        continue;
      }
      const context = this.contextForResource(host.resource);
      if (!context || context.target.kind === 'workspaceDraft') {
        continue; // drafts may hold unsent work and don't auto-restart — never reap
      }
      const snap = context.controller.snapshot;
      if (snap.connectionState !== 'ready') {
        continue; // only reap settled sessions — never starting/busy/faulted
      }
      if (snap.state.isStreaming === true || (snap.pendingUi?.length ?? 0) > 0) {
        continue; // never touch generating chats or chats awaiting approval
      }
      const last = this.lastActivityAt.get(context.controller);
      if (last === undefined) {
        // First sighting: start the idle clock now instead of guessing.
        this.lastActivityAt.set(context.controller, Date.now());
        continue;
      }
      if (last > cutoff) {
        continue;
      }
      try {
        await context.controller.stop();
        this.logger.info(
          `Reaped idle session for hidden chat (idle ${Math.round((Date.now() - last) / 60_000)}m) — restarts on focus`
        );
        await this.renderResource(host.resource);
      } catch (error) {
        this.logger.warn(
          `Idle reap failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
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
    this.follow.dispose();
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = undefined;
    }
    for (const disposable of this.controllerSubscriptions) {
      disposable.dispose();
    }
    for (const host of this.hosts.values()) {
      host.dispose();
    }
    this.hosts.clear();
    this.cache.dispose();
    this.openChatsEmitter.dispose();
  }

  public trackController(controller: SessionController): void {
    this.ensureTracked(controller);
  }

  public async resolveEditor(
    document: ChatEditorDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    // Hosts are keyed by RESOURCE URI (stable) — NOT by session key: binding a
    // draft to its session changes keyFor()'s answer for the same URI, which
    // orphaned the host entry and silently dropped every live repaint.
    const key = document.uri.toString();
    this.hosts.get(key)?.dispose();
    const host = new ChatEditorHost(this.context.extensionUri, document, panel, this);
    this.hosts.set(key, host);
    this.openChatsEmitter.fire();
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

  /**
   * #2 — "Ask Pi": capture the active editor selection as context, open/reveal
   * a chat for that file's folder, and prefill the composer with an instruction.
   * The user reviews and sends. Capture happens BEFORE revealing the chat, since
   * revealing changes the active editor.
   */
  public async askWithSelection(instruction: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Select some code first, then choose Ask Pi.');
      return;
    }
    const editorFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!editorFolder) {
      void vscode.window.showWarningMessage('Ask Pi works on files inside the workspace.');
      return;
    }
    const controller = this.registry.getOrCreate(editorFolder);
    const item = await captureSelection(controller);
    const resource = await this.openCurrentChat({
      folderUri: controller.folder.uri.toString(),
      focusComposer: true,
    });
    if (!resource) {
      return;
    }
    const context = this.contextForResource(resource);
    if (!context) {
      return;
    }
    if (item) {
      await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
    }
    const state = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    state.draft = instruction;
    state.composerResetSeq = (state.composerResetSeq ?? 0) + 1;
    state.focus = 'composer';
    await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
    await this.renderResource(context.resource);
    await this.focusComposer(context.resource);
  }

  /**
   * #3 — open the file an edit/write tool touched, or its diff. Pi applies edits
   * itself, so "Open changes" shows the working-tree diff via the git extension
   * (best-effort; falls back to just opening the file).
   */
  private async openEditToolFile(
    context: ChatTabContext,
    filePath: string,
    diff: boolean
  ): Promise<void> {
    // Prose file mentions arrive as "path:line" or "path:line:col"
    // (linkifyFileMentions in render.ts) — split the suffix off and jump
    // there. The Windows drive prefix (C:\…) never matches: the line part
    // requires the colon to be followed by digits AND end the string.
    const lineMatch = /^(.*?):(\d{1,6})(?::(\d{1,6}))?$/.exec(filePath);
    const cleanPath = lineMatch ? lineMatch[1]! : filePath;
    const line = lineMatch ? Number.parseInt(lineMatch[2]!, 10) : undefined;
    const column = lineMatch?.[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
    const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(cleanPath);
    const target = isAbsolute
      ? vscode.Uri.file(cleanPath)
      : vscode.Uri.joinPath(context.controller.folder.uri, cleanPath);
    if (diff) {
      try {
        await vscode.commands.executeCommand('git.openChange', target);
        return;
      } catch {
        /* git unavailable or file untracked — fall back to opening it */
      }
    }
    try {
      const selection =
        line !== undefined
          ? new vscode.Range(
              Math.max(0, line - 1),
              Math.max(0, (column ?? 1) - 1),
              Math.max(0, line - 1),
              Math.max(0, (column ?? 1) - 1)
            )
          : undefined;
      await vscode.window.showTextDocument(target, { preview: !diff, selection });
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${cleanPath}.`);
    }
  }

  /** #9 — resolve a path/URI to a workspace file and attach it as context. */
  private async attachFileByPath(context: ChatTabContext, filePath: string): Promise<void> {
    let uri: vscode.Uri;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath)) {
      uri = vscode.Uri.parse(filePath);
    } else if (/^([a-zA-Z]:[\\/]|[\\/])/.test(filePath)) {
      uri = vscode.Uri.file(filePath);
    } else {
      uri = vscode.Uri.joinPath(context.controller.folder.uri, filePath);
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const item = await captureFileLike(context.controller, document, 'pickedFile');
      if (item) {
        await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
        await this.renderResource(context.resource);
      }
    } catch {
      void vscode.window.showWarningMessage(`Could not attach ${filePath}.`);
    }
  }

  /** #9 — fuzzy file search for @-mentions, scoped to the chat's folder. */
  private async searchWorkspaceFiles(
    context: ChatTabContext,
    query: string
  ): Promise<Array<{ path: string; name: string }>> {
    const folder = context.controller.folder;
    const safe = query.trim().replace(/[^\w.\-/]/g, '');
    const glob = safe ? `**/*${safe}*` : '**/*';
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder.uri, glob),
        '**/{node_modules,.git,dist,out,build,.next,coverage}/**',
        200
      );
      return uris
        .map((uri) => relativeWorkspacePath(folder, uri) ?? '')
        .filter((path) => path.length > 0)
        .sort((a, b) => a.length - b.length)
        .slice(0, 8)
        .map((path) => ({ path, name: basename(path) }));
    } catch {
      return [];
    }
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

  /** Text of the most recent user prompt in the active chat (for Retry). */
  public getLastUserPrompt(): string | undefined {
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
    for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
      const message = snapshot.messages[i];
      if (message?.role === 'user') {
        const text = message.text.trim();
        return text.length > 0 ? text : undefined;
      }
    }
    return undefined;
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

  /** Deleting an ACTIVE session must also shut its runtime down — tabs alone
   * left the controller running headless. Fire-and-forget: the UI never waits
   * on process teardown. */
  public stopControllersForSessionFile(sessionFile: string): void {
    const wanted = normalizeSessionFilePath(sessionFile);
    for (const controller of this.trackedControllers) {
      const target = currentTargetForController(controller);
      if (
        target.kind === 'sessionFile' &&
        target.sessionFile &&
        normalizeSessionFilePath(target.sessionFile) === wanted
      ) {
        void Promise.resolve(controller.abort?.())
          .catch(() => undefined)
          .finally(() => void controller.stop().catch(() => undefined));
      }
    }
  }

  /** Close a specific tab by its exact resource URI — for chats that have no
   * session file yet (a fresh draft never sent, or sent but not yet
   * persisted), where closeForSessionFile's path/identity matching has
   * nothing to match against. Deleting such a chat from the Agentic Mode
   * list has nothing on disk to remove; closing its tab is the only
   * meaningful action, and silently doing nothing (which is what happened
   * before this existed — reported as "delete doesn't seem to work") isn't
   * an acceptable substitute for it. */
  public async closeResource(resource: vscode.Uri): Promise<void> {
    const key = resource.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = (tab.input ?? undefined) as
          | { uri?: vscode.Uri; viewType?: string }
          | undefined;
        if (input?.viewType === CHAT_EDITOR_VIEW_TYPE && input.uri?.toString() === key) {
          await vscode.window.tabGroups.close(tab);
        }
      }
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
    this.lastActivityAt.set(context.controller, Date.now());
    const workspaceKey = context.target.workspaceFolderUri;
    const previousResource = this.activeResourceByWorkspace.get(workspaceKey);
    this.activeResourceByWorkspace.set(workspaceKey, resource.toString());

    const connectionState = context.controller.snapshot.connectionState;
    // Per-tab controller: it is DEDICATED to this tab's session, so we only ever
    // START it (on its session file, or a fresh one) — never switchSession.
    // Starting can take seconds (managed bootstrap, worker boot, per-session
    // extension/MCP load), so it runs in the BACKGROUND: this method paints the
    // loading state and returns immediately; controller state events repaint the
    // tab as the session comes up. Callers that must talk to Pi (prompting)
    // await controller.whenReady() themselves.
    const sessionFile =
      context.target.kind === 'sessionFile' ? context.target.sessionFile : undefined;
    if (connectionState === 'stopped' && (sessionFile || options?.startIfStopped)) {
      void (async () => {
        try {
          await context.controller.start(sessionFile);
          await context.controller.reconcile();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A readiness timeout during (rapid) switching is transient and
          // self-heals — log it, don't nag. Only surface genuine load failures.
          if (/Timed out waiting for Pi to be ready|Pi is not running/i.test(message)) {
            this.logger.warn(
              `Session load deferred (Pi busy) for ${context.target.sessionFile ?? context.target.kind}: ${message}`
            );
          } else {
            this.logger.error(
              `Failed to load session for ${context.target.sessionFile ?? context.target.kind}`,
              error
            );
            void vscode.window
              .showErrorMessage(`Pi: couldn't load this chat — ${message}`, 'Show Logs')
              .then((choice) => {
                if (choice === 'Show Logs') {
                  void vscode.commands.executeCommand('piRpcInternal.showLogs');
                }
              });
          }
        }
        await this.renderResource(resource);
      })();
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
      const context = await this.activateResource(resource, { startIfStopped: true });
      // Prompting requires a live client — activation starts Pi in the
      // background, so wait for readiness here (with the controller's timeout).
      await context?.controller.whenReady();
      return context;
    }
    if (current.controller.snapshot.connectionState === 'stopped') {
      await current.controller.start();
      await current.controller.reconcile();
    }
    await current.controller.whenReady();
    const draftState = await this.uiState.getComposerStateForIdentity(
      current.controller,
      current.target
    );
    // A draft controller that adopted the prewarmed session already sits on a
    // FRESH empty session — reuse it instead of creating yet another one (which
    // also churns extension/MCP rebinds).
    const messageCount = Number(current.controller.snapshot.state.messageCount ?? 0);
    const alreadyFresh =
      messageCount === 0 && typeof current.controller.snapshot.state.sessionFile === 'string';
    if (!alreadyFresh) {
      const result = await current.controller.newSession();
      if (result?.cancelled === true) {
        return undefined;
      }
    }
    await this.nameSessionIfUnnamed(current.controller);
    const nextTarget = currentTargetForController(current.controller);
    await this.uiState.setComposerStateForIdentity(current.controller, nextTarget, draftState);
    await this.uiState.clearComposerStateForIdentity(current.controller, current.target);
    const nextResource = buildChatUri(nextTarget);
    await this.promoteResource(resource, nextResource, current.controller);
    // The tab keeps the DRAFT uri (now bound to the session) — no tab swap.
    return this.activateResource(resource, { startIfStopped: false });
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
        const target = this.resolveTarget(input.uri);
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
        // Unique per click: every New Chat is a FRESH draft tab, and a draft
        // that became a session keeps living in its own tab (bound in place).
        draftId: `d${this.nextSessionNumber()}`,
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
    return draftResource;
  }

  public async onHostDisposed(host: ChatHost): Promise<void> {
    // Controller key BEFORE dropping the binding (afterwards keyFor would
    // resolve back to the raw draft key and miss the registry entry).
    const controllerKey = this.keyFor(host.resource);
    const resourceKey = host.resource.toString();
    this.sessions.unbind(resourceKey);
    if (this.hosts.get(resourceKey) === host) {
      this.hosts.delete(resourceKey);
      this.openChatsEmitter.fire();
    }
    await this.cache.markClosed(host.resource);
    // Closing the tab tears down its dedicated Pi session (parallel-session
    // model), unless another open tab still resolves to the same session key.
    const stillOpen = [...this.hosts.values()].some(
      (other) => this.keyFor(other.resource) === controllerKey
    );
    if (!stillOpen) {
      this.registry.remove(controllerKey);
    }
  }

  public async onHostViewStateChanged(host: ChatHost, active: boolean): Promise<void> {
    // Which tab is "active" (the Agentic Mode list's checkmark) can change
    // WITHOUT any host ever being added or removed — switching focus between
    // two already-open tabs doesn't re-run resolveEditor (VS Code only calls
    // that once per tab's lifetime), so the only place that transition is
    // ever observable is here. Without this, the list's active state only
    // ever reflected whatever was focused the last time a tab was actually
    // opened or closed — reported as "multiple sessions open, but no chat
    // seems to be opened" (the real one was open, the list just never found
    // out focus had moved to it).
    this.openChatsEmitter.fire();
    if (!active) {
      return;
    }
    await this.activateResource(host.resource, { startIfStopped: false });
  }

  public async onMessage(host: ChatHost, message: unknown): Promise<void> {
    const parsed = parseWebviewMessage(message);
    const context = this.contextForResource(host.resource);
    if (!parsed || !context) {
      return;
    }

    switch (parsed.type) {
      case 'loadOlder':
        return this.revealOlderMessages(host.resource);
      case 'openExternal':
        return this.handleOpenExternal(parsed.url);
      case 'openFile':
        return this.openEditToolFile(context, parsed.path, false);
      case 'openDiff':
        return this.openEditToolFile(context, parsed.path, true);
      case 'respondUi':
        return this.handleRespondUi(context, parsed.id, parsed.value, parsed.confirmed);
      case 'attachFile':
        return this.attachFileByPath(context, parsed.path);
      case 'requestFileMentions':
        return this.handleRequestFileMentions(host, context, parsed.query);
      case 'requestSlashCommands':
        return this.handleRequestSlashCommands(host, context);
      case 'insertCode':
        return this.insertCodeIntoEditor(parsed.text);
      case 'newFileFromCode':
        return this.openCodeInNewFile(parsed.text, parsed.language);
      case 'requestSend':
        return this.handleRequestSend(host.resource, parsed.command, parsed.follow === true);
      case 'acceptPreview':
        return this.acceptPreview(host.resource);
      case 'cancelPreview':
        return this.handleCancelPreview(context, host.resource);
      case 'copyAcceptedSnapshot':
        return this.handleCopyAcceptedSnapshot(context, host.resource);
      case 'sendAcceptedSnapshotAgain':
        return this.handleSendAcceptedSnapshotAgain(context, host.resource);
      case 'requestReview':
        return this.handleRequestReview(host);
      case 'reviewAction':
        return this.handleReviewAction(parsed.action, parsed.turn, parsed.file);
      case 'requestChatList':
        this.sendChatList(host);
        return;
      case 'deleteChatSession':
        return this.handleDeleteChatSession(host, parsed.path, parsed.title);
      case 'openChatSession':
        return this.handleOpenChatSession(host, parsed.workspaceFolderUri, parsed.path);
      case 'newChatSession':
        return this.handleNewChatSession(host);
      case 'screenOpenFile':
        return this.handleScreenOpenFile(parsed.path, parsed.needle);
      case 'screenRevert':
        return this.handleScreenRevert(parsed.path, parsed.oldText, parsed.newText);
      case 'toggleFollow':
        return this.handleToggleFollow(host.resource);
      case 'abort':
        return this.handleAbort(host.resource);
      case 'setDraft':
        return this.handleSetDraft(context, parsed.resetSeq, parsed.text);
      case 'setFocus':
        return this.uiState.setFocusForIdentity(context.controller, context.target, parsed.focus);
      case 'executeCommand':
        return this.handleExecuteCommand(parsed.command, parsed.argument);
      case 'pickImages':
        return this.handlePickImages(context, host.resource);
      case 'pasteImage':
        return this.handlePasteImage(context, host.resource, parsed.data, parsed.mimeType);
      case 'clearAttachments':
        return this.handleClearAttachments(context, host.resource);
      case 'appendActiveFile':
        return this.handleAppendActiveFile(context, host.resource);
      case 'appendSelection':
        return this.handleAppendSelection(context, host.resource);
      case 'appendDiagnostics':
        return this.handleAppendDiagnostics(context, host.resource);
      case 'appendPickedFile':
        return this.handleAppendPickedFile(context, host.resource);
      case 'removeContextItem':
        return this.handleRemoveContextItem(context, host.resource, parsed.itemId);
      case 'removeImageItem':
        return this.handleRemoveImageItem(context, host.resource, parsed.itemId);
      case 'openAttachment':
        return this.handleOpenAttachment(host, parsed.uri);
      case 'switchFolder':
        return this.handleSwitchFolder(parsed.folderUri);
      case 'debugLog':
        context.controller.log('info', `[webview] ${parsed.text}`);
        return;
      case 'forkAndSend':
        return this.forkAndSendInTab(
          context,
          parsed.fromBottom,
          parsed.originalText,
          parsed.text,
          parsed.pickModel === true
        );
      default:
        return;
    }
  }

  // Batch 6 of the onMessage de-bloat (A4): everything else (system/utility
  // handlers with real inline logic — the ones that were ALREADY a single
  // delegate call, like loadOlder/openFile/attachFile, just got terse-ified
  // in place, no new method needed for those).
  private async handleOpenExternal(url: string): Promise<void> {
    if (/^https?:\/\//i.test(url)) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private async handleRespondUi(
    context: ChatTabContext,
    id: string,
    value: string | undefined,
    confirmed: boolean | undefined
  ): Promise<void> {
    const response: JsonObject = { id };
    if (typeof value === 'string') {
      response.value = value;
    }
    if (typeof confirmed === 'boolean') {
      response.confirmed = confirmed;
    }
    await context.controller.respondExtensionUi(response);
    context.controller.completeExtensionUiRequest(id);
  }

  private async handleRequestFileMentions(
    host: ChatHost,
    context: ChatTabContext,
    query: string
  ): Promise<void> {
    const items = await this.searchWorkspaceFiles(context, query);
    host.post({ type: 'fileMentions', items });
  }

  private async handleRequestSlashCommands(host: ChatHost, context: ChatTabContext): Promise<void> {
    // #6 — supply the slash-command list for inline composer autocomplete.
    try {
      const commands = await context.controller.getPiCommands();
      const items = commands
        .map((command) => ({
          name: typeof command.name === 'string' ? command.name : '',
          description: typeof command.description === 'string' ? command.description : '',
        }))
        .filter((command) => command.name.length > 0);
      host.post({ type: 'slashCommands', items });
    } catch {
      host.post({ type: 'slashCommands', items: [] });
    }
  }

  private async handleToggleFollow(resource: vscode.Uri): Promise<void> {
    const config = vscode.workspace.getConfiguration('piRpc');
    const next = config.get<string>('followAgent', 'open') === 'open' ? 'off' : 'open';
    await config.update('followAgent', next, vscode.ConfigurationTarget.Global);
    await this.renderResource(resource);
    if (next === 'open') {
      this.follow.replayLast(); // jump to the file π is on
    }
    // No toast: the crosshair + status bar already show the state.
  }

  private async handleAbort(resource: vscode.Uri): Promise<void> {
    const live = await this.activateResource(resource, { startIfStopped: false });
    await live?.controller.abort();
  }

  private async handleExecuteCommand(command: string, argument: unknown): Promise<void> {
    // SECURITY: the webview may only invoke this fixed allowlist. Without it,
    // any HTML-escaping slip in the renderer would escalate to arbitrary
    // VS Code command execution (terminal writes, file ops, …).
    if (!WEBVIEW_COMMAND_ALLOWLIST.has(command)) {
      this.logger.warn(`Blocked non-allowlisted webview command: ${command}`);
      return;
    }
    try {
      await vscode.commands.executeCommand(command, argument);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window
        .showErrorMessage(`Pi: ${command} failed — ${message}`, 'Show Logs')
        .then((choice) => {
          if (choice === 'Show Logs') {
            void vscode.commands.executeCommand('piRpcInternal.showLogs');
          }
        });
    }
  }

  private async handleSwitchFolder(folderUri: string): Promise<void> {
    this.registry.setActive(folderUri);
    await this.openCurrentChat({ folderUri });
  }

  // Batch 5 of the onMessage de-bloat (A4): screen/file-op handlers.
  private async handleScreenOpenFile(path: string, needle: string | undefined): Promise<void> {
    // Ownership handoff: open the REAL file (optionally at a region).
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (needle) {
        const at = doc.getText().indexOf(needle);
        if (at >= 0) {
          const range = new vscode.Range(doc.positionAt(at), doc.positionAt(at + needle.length));
          editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          editor.selection = new vscode.Selection(range.start, range.start);
        }
      }
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleScreenRevert(
    path: string,
    oldText: string | undefined,
    newText: string | undefined
  ): Promise<void> {
    // Per-change undo: swap this edit's newString back to oldString.
    try {
      const uri = vscode.Uri.file(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const resolvedNewText = newText ?? '';
      const at = resolvedNewText ? text.indexOf(resolvedNewText) : -1;
      if (at < 0) {
        void vscode.window.showWarningMessage(
          'That change no longer matches the file (edited since?) — use the π Review panel for a full-file revert.'
        );
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(doc.positionAt(at), doc.positionAt(at + resolvedNewText.length)),
        oldText ?? ''
      );
      await vscode.workspace.applyEdit(edit);
      await doc.save(); // the file itself shows the result — no toast
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Undo failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Batch 4 of the onMessage de-bloat (A4): review/replay handlers.
  private async handleRequestReview(host: ChatHost): Promise<void> {
    const relative = (at: number): string => {
      const mins = Math.max(1, Math.round((Date.now() - at) / 60_000));
      return mins < 60
        ? `${mins}m`
        : mins < 1440
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / 1440)}d`;
    };
    host.post({
      type: 'reviewData',
      turns: (this.turnReview?.history ?? []).map((record, index) => ({
        index,
        title: record.title,
        time: relative(record.at),
        files: record.changes.map((change) => ({
          file: change.file,
          kind: change.kind,
          added: change.added,
          deleted: change.deleted,
        })),
      })),
    });
  }

  private async handleReviewAction(
    action: 'diff' | 'inline' | 'revertFile' | 'revertTurn' | 'replayTurn' | 'replaySession',
    turn: number,
    file: string | undefined
  ): Promise<void> {
    const record = this.turnReview?.history[turn];
    if (!record || !this.turnReview) {
      return;
    }
    if (action === 'diff' && file) {
      const change = record.changes.find((entry) => entry.file === file);
      if (change) {
        await this.turnReview.openDiff(record, change);
      }
    } else if (action === 'inline' && file) {
      const change = record.changes.find((entry) => entry.file === file);
      if (change) {
        await this.inlineReview?.start(record, change);
      }
    } else if (action === 'replayTurn') {
      void this.sessionReplay?.replayTurn(record);
    } else if (action === 'replaySession') {
      void this.sessionReplay?.replaySession(this.turnReview?.history ?? []);
    } else if (action === 'revertFile' && file) {
      const change = record.changes.find((entry) => entry.file === file);
      if (!change) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Revert ${change.file} to its state before this turn?`,
        { modal: true },
        'Revert'
      );
      if (confirm === 'Revert') {
        await this.turnReview.revertFile(record, change);
      }
    } else if (action === 'revertTurn') {
      const confirm = await vscode.window.showWarningMessage(
        `Revert all ${record.changes.length} file(s) from this turn?`,
        { modal: true },
        'Revert All'
      );
      if (confirm === 'Revert All') {
        for (const change of record.changes) {
          await this.turnReview.revertFile(record, change).catch(() => undefined);
        }
      }
    }
  }

  // Batch 3 of the onMessage de-bloat (A4): sidebar chat-list handlers.
  private async handleDeleteChatSession(
    host: ChatHost,
    path: string,
    title: string | undefined
  ): Promise<void> {
    if (host.resource.scheme !== 'piRpcSidebar') {
      return;
    }
    const wasCurrent =
      this.sidebarTarget?.kind === 'sessionFile' && this.sidebarTarget.sessionFile === path;
    await vscode.commands.executeCommand('piRpcInternal.deleteSession', {
      sessionPath: path,
      sessionLabel: title,
    });
    if (wasCurrent) {
      // The chat being viewed was deleted — hand the surface a fresh draft.
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) {
        this.sidebarTarget = {
          workspaceFolderUri: folder.uri.toString(),
          kind: 'workspaceDraft',
          draftId: `sidebar-${Date.now()}`,
        };
        this.persistSidebarTarget();
        await this.activateResource(host.resource, { startIfStopped: true });
        await this.renderResource(host.resource, { active: true });
      }
    }
    this.sendChatList(host, path); // optimistic: gone immediately
  }

  private async handleOpenChatSession(
    host: ChatHost,
    workspaceFolderUri: string | undefined,
    path: string
  ): Promise<void> {
    if (host.resource.scheme !== 'piRpcSidebar') {
      return;
    }
    const folder =
      vscode.workspace.workspaceFolders?.find(
        (candidate) => workspaceFolderUri === candidate.uri.toString()
      ) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    this.sidebarTarget = {
      workspaceFolderUri: folder.uri.toString(),
      kind: 'sessionFile',
      sessionFile: path,
    };
    this.persistSidebarTarget();
    this.logger.info(`[sidebar] switch → ${path.split('/').pop() ?? ''}`);
    await this.activateResource(host.resource, { startIfStopped: true });
    await this.renderResource(host.resource, { active: true });
  }

  private async handleNewChatSession(host: ChatHost): Promise<void> {
    if (host.resource.scheme !== 'piRpcSidebar') {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    this.sidebarTarget = {
      workspaceFolderUri: folder.uri.toString(),
      kind: 'workspaceDraft',
      draftId: `sidebar-${Date.now()}`,
    };
    this.persistSidebarTarget();
    await this.activateResource(host.resource, { startIfStopped: true });
    await this.renderResource(host.resource, { active: true });
  }

  // Batch 2 of the onMessage de-bloat (A4): composer/send-flow handlers.
  private async handleCancelPreview(context: ChatTabContext, resource: vscode.Uri): Promise<void> {
    const state = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    state.preview = undefined;
    state.focus = 'composer';
    await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
    await this.renderResource(resource);
  }

  private async handleCopyAcceptedSnapshot(
    context: ChatTabContext,
    resource: vscode.Uri
  ): Promise<void> {
    await this.uiState.copyAcceptedSnapshotToComposerForIdentity(
      context.controller,
      context.target
    );
    await this.renderResource(resource);
  }

  private async handleSendAcceptedSnapshotAgain(
    context: ChatTabContext,
    resource: vscode.Uri
  ): Promise<void> {
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
      await this.handleRequestSend(resource, command);
    } else {
      await this.renderResource(resource);
    }
  }

  private async handleSetDraft(
    context: ChatTabContext,
    resetSeq: number | undefined,
    text: string
  ): Promise<void> {
    const state = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    // Drop STALE updates: each update carries the composerResetSeq it was
    // typed under. A send bumps the seq while clearing the draft — a trailing
    // debounced update from before the send would otherwise re-persist the
    // just-sent text, which then popped back into the input on re-render.
    if (typeof resetSeq === 'number' && resetSeq !== (state.composerResetSeq ?? 0)) {
      return;
    }
    state.draft = text;
    // FINAL gate in the same microtask as the memory write: the async read
    // above can be overtaken by a send's clear+seq-bump when the draft is
    // LARGE (slow restore/validate) — writing the stale snapshot would
    // resurrect the just-sent text AND roll the seq back. peek() reads the
    // live map synchronously, so nothing can interleave before the write.
    if (
      typeof resetSeq === 'number' &&
      this.uiState.peekComposerResetSeq(context.target) !== resetSeq
    ) {
      return;
    }
    // Persist the draft SILENTLY: no controller fire, no UI-state fire, so a
    // keystroke never re-renders the tab (which flickered the scrollbar).
    await this.uiState.setComposerStateForIdentity(context.controller, context.target, state, {
      silent: true,
    });
  }

  // Batch 1 of the onMessage de-bloat (A4): attachment/context-item handlers,
  // extracted verbatim from their old inline case bodies — mechanical moves,
  // no logic changes, each verified byte-identical against the original
  // before wiring in.
  private async handlePickImages(context: ChatTabContext, resource: vscode.Uri): Promise<void> {
    await this.pickImages(context.controller, context.target, resource);
  }

  private async handlePasteImage(
    context: ChatTabContext,
    resource: vscode.Uri,
    data: string,
    mimeType: string
  ): Promise<void> {
    await this.addPastedImage(context, resource, data, mimeType);
  }

  private async handleClearAttachments(
    context: ChatTabContext,
    resource: vscode.Uri
  ): Promise<void> {
    await this.uiState.clearAttachmentsForIdentity(context.controller, context.target);
    await this.renderResource(resource);
  }

  private async handleAppendActiveFile(
    context: ChatTabContext,
    resource: vscode.Uri
  ): Promise<void> {
    const item = await captureActiveFile(context.controller);
    if (item) {
      await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
      await this.renderResource(resource);
    }
  }

  private async handleAppendSelection(
    context: ChatTabContext,
    resource: vscode.Uri
  ): Promise<void> {
    const item = await captureSelection(context.controller);
    if (item) {
      await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
      await this.renderResource(resource);
    }
  }

  private async handleAppendDiagnostics(
    context: ChatTabContext,
    resource: vscode.Uri
  ): Promise<void> {
    const item = await captureDiagnostics(context.controller);
    if (item) {
      await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
      await this.renderResource(resource);
    }
  }

  private async handleAppendPickedFile(
    context: ChatTabContext,
    resource: vscode.Uri
  ): Promise<void> {
    const item = await capturePickedFile(context.controller);
    if (item) {
      await this.uiState.addContextItemForIdentity(context.controller, context.target, item);
      await this.renderResource(resource);
    }
  }

  private async handleRemoveContextItem(
    context: ChatTabContext,
    resource: vscode.Uri,
    itemId: string
  ): Promise<void> {
    await this.uiState.removeContextItemForIdentity(context.controller, context.target, itemId);
    await this.renderResource(resource);
  }

  private async handleRemoveImageItem(
    context: ChatTabContext,
    resource: vscode.Uri,
    itemId: string
  ): Promise<void> {
    await this.uiState.removeImageItemForIdentity(context.controller, context.target, itemId);
    await this.renderResource(resource);
  }

  private async handleOpenAttachment(host: ChatHost, uri: string): Promise<void> {
    if (host.hasAttachment(uri)) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri, true));
    }
  }

  // Inline edit + resubmit for editor tabs (ChatGPT/Continue style): fork the
  // session at the edited user message (dropping everything after it), then send
  // the edited text as the new turn on the tab's OWN controller.
  private async forkAndSendInTab(
    context: ChatTabContext,
    fromBottom: number,
    originalText: string,
    text: string,
    pickModelFirst?: boolean
  ): Promise<void> {
    const controller = context.controller;
    const edited = text.trim();
    controller.log(
      'info',
      `[edit] forkAndSend (tab): fromBottom=${fromBottom}, chars=${edited.length}, pickModel=${Boolean(pickModelFirst)}`
    );
    if (!edited) {
      return;
    }
    let pickedModel: { provider: string; id: string } | undefined;
    try {
      ensureTrustedForMutation();
      if (pickModelFirst) {
        pickedModel = await pickChatModel(controller);
        if (!pickedModel) {
          controller.log('info', '[edit] model pick cancelled — resend aborted');
          await this.renderResource(context.resource); // repaint the untouched transcript
          return;
        }
        controller.log('info', `[edit] model picked: ${pickedModel.provider}/${pickedModel.id}`);
      }
      const entries = await controller.getForkMessages();
      controller.log('info', `[edit] fork points available: ${entries.length}`);
      if (entries.length === 0) {
        void vscode.window.showWarningMessage(
          'Pi: this session has no branch points to edit from yet.'
        );
        return;
      }
      const wanted = originalText.trim();
      let entry = entries[entries.length - 1 - fromBottom];
      if (wanted && (!entry || String(entry.text ?? '').trim() !== wanted)) {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const candidate = entries[i];
          if (candidate && String(candidate.text ?? '').trim() === wanted) {
            entry = candidate;
            break;
          }
        }
      }
      const entryId = typeof entry?.entryId === 'string' ? entry.entryId : undefined;
      if (!entryId) {
        void vscode.window.showWarningMessage('Pi: could not locate that message to edit.');
        return;
      }
      controller.log('info', `[edit] forking IN-PLACE at entryId=${entryId}`);
      // Lean in-place fork: branches in the SAME session file without a full
      // reconcile, so the tab stays bound to this session (no new tab/session).
      await controller.forkInPlace(entryId);
      controller.setDraft('');
      const state = await this.uiState.getComposerStateForIdentity(
        context.controller,
        context.target
      );
      state.draft = '';
      state.preview = undefined;
      state.acceptedSendSnapshot = undefined;
      await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
      await this.renderResource(context.resource);
      controller.log('info', '[edit] fork complete; resubmitting edited text to the model');
      if (controller.snapshot.connectionState === 'stopped') {
        await controller.start();
      }
      if (pickedModel) {
        // Re-assert the picked model AFTER forking — forking replays session
        // history up to the branch point, which can put the live connection
        // back on whatever model was active at THAT point in history rather
        // than the one just picked. Cheap and idempotent; guarantees the
        // resend actually uses what was chosen, not the old (rate-limited) one.
        await controller.selectModel(pickedModel.provider, pickedModel.id);
        controller.log(
          'info',
          `[edit] re-asserted model after fork: ${pickedModel.provider}/${pickedModel.id}`
        );
        // Confirm it actually stuck rather than assuming the awaited call
        // succeeding means the session is now on it — reported once as
        // "still uses the old model" with no visible way to tell.
        const appliedModel = controller.snapshot.state.model as
          | { provider?: unknown; id?: unknown }
          | undefined;
        const appliedKey = appliedModel ? `${appliedModel.provider}/${appliedModel.id}` : undefined;
        const wantedKey = `${pickedModel.provider}/${pickedModel.id}`;
        if (appliedKey !== wantedKey) {
          controller.log(
            'warn',
            `[edit] model re-assert did not stick: wanted ${wantedKey}, session reports ${appliedKey}`
          );
          void vscode.window.showWarningMessage(
            `Pi: asked for ${wantedKey}, session reports ${appliedKey ?? 'unknown'} — the resend may still use the old model.`
          );
        }
      }
      await controller.prompt(edited, 'prompt', []);
      controller.log('info', '[edit] prompt sent to model');
      await this.renderResource(context.resource);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      controller.log('error', `[edit] failed: ${detail}`);
      void vscode.window.showErrorMessage(`Pi: edit & resend failed \u2014 ${detail}`);
    }
  }

  private async handleRequestSend(
    resource: vscode.Uri,
    command: 'prompt' | 'follow_up' | 'steer',
    followOnce?: boolean
  ): Promise<void> {
    if (followOnce) {
      this.follow.armOnce(this.keyFor(resource));
    }
    ensureTrustedForMutation();
    let context = this.contextForResource(resource);
    if (!context) {
      return;
    }
    let state = await this.uiState.getComposerStateForIdentity(context.controller, context.target);
    state.recovery = undefined;
    state.preview = undefined;
    const origin = { controller: context.controller, target: context.target };
    try {
      // Images/context items send IMMEDIATELY with the message — no confirmation
      // popup. beginSend captures the outgoing message and clears the WHOLE
      // composer (draft + context chips + image chips) in one step, BEFORE the
      // async session work below: nothing sent may linger into the next message,
      // and the draft→session identity promotion copies an already-clean state.
      const { preview, accepted } = beginSend(command, state);
      context.controller.setDraft('');
      await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
      context = await this.preparePromptContext(resource);
      if (!context) {
        // Session creation cancelled — put back exactly what was cleared.
        const current = await this.uiState.getComposerStateForIdentity(
          origin.controller,
          origin.target
        );
        Object.assign(current, restoreEditableStateFromAcceptedSnapshot(accepted));
        current.acceptedSendSnapshot = undefined;
        current.composerResetSeq = (current.composerResetSeq ?? 0) + 1;
        origin.controller.setDraft(current.draft);
        await this.uiState.setComposerStateForIdentity(origin.controller, origin.target, current);
        await this.renderResource(resource);
        return;
      }
      state = await this.uiState.getComposerStateForIdentity(context.controller, context.target);
      await this.sendPreview(
        context.resource,
        context.controller,
        context.target,
        state,
        preview,
        accepted
      );
    } catch (error) {
      if (!context) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      // Empty composer + Enter is a non-event, not an error — stay silent.
      if (detail.startsWith('Enter a message')) {
        return;
      }
      state.recovery = {
        kind: 'preflightError',
        title: 'Can\u2019t send yet.',
        detail,
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
    preview: NonNullable<
      Awaited<ReturnType<ChatUiState['getComposerStateForIdentity']>>['preview']
    >,
    acceptedFromBegin?: AcceptedSendSnapshot
  ): Promise<void> {
    // beginSend already cleared the chips, so rebuilding the accepted snapshot
    // from state here would lose them — use the one captured at begin time.
    const accepted =
      acceptedFromBegin ?? acceptedSnapshotFromPreview(preview, state.pendingContextItems);
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

  // ALL tab↔session identity questions route through SessionIndex (#2 of the
  // hardening review) — bindings, owners, effective targets, registry keys.
  private readonly sessions: SessionIndex;

  private sidebarTarget: ChatTabTarget | undefined;
  private static readonly SIDEBAR_LAST_TARGET_KEY = 'piRpc.sidebarLastTarget';

  /** Remember the sidebar's current chat so a reload restores it instead of
   * always landing on a blank draft — the sidebar is the primary surface. */
  private persistSidebarTarget(): void {
    if (this.sidebarTarget) {
      void this.context.workspaceState.update(
        ChatTabManager.SIDEBAR_LAST_TARGET_KEY,
        this.sidebarTarget
      );
    }
  }

  /** Agentic Mode's sidebar shows only a chat LIST — "current chat" moves to
   * an editor tab instead. Switching modes must never leave the SAME
   * conversation visible in both places at once (an explicit regression
   * report) — this closes the tab when its chat becomes the sidebar's, and
   * opens a tab when the sidebar's chat needs to become one. Scoped to
   * chats with a real session file; a brand-new empty draft has nothing
   * worth migrating (Agentic Mode's own New Chat button covers that). */
  public async syncSidebarModeTransition(toMode: 'agentic' | 'chat'): Promise<void> {
    if (toMode === 'chat') {
      const active = this.getActiveContext();
      const sessionFile = active?.controller.snapshot.state.sessionFile;
      if (!active || !sessionFile) {
        return;
      }
      this.sidebarTarget = {
        workspaceFolderUri: active.controller.folder.uri.toString(),
        kind: 'sessionFile',
        sessionFile,
      };
      this.persistSidebarTarget();
      await this.closeForSessionFile(sessionFile);
      return;
    }
    const target = this.sidebarTarget;
    if (target?.kind !== 'sessionFile' || !target.sessionFile) {
      return;
    }
    const folder =
      vscode.workspace.workspaceFolders?.find(
        (f) => f.uri.toString() === target.workspaceFolderUri
      ) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    await this.openForSessionFile(this.registry.getOrCreate(folder), target.sessionFile);
  }

  /** Injected: line-by-line review engine. */
  public inlineReview: { start(record: unknown, change: unknown): Promise<void> } | undefined;
  /** Injected: session replay (walk past turns' files, oldest or single). */
  public sessionReplay:
    | {
        replayTurn(record: unknown): Promise<void>;
        replaySession(history: unknown[]): Promise<void>;
      }
    | undefined;
  /** Injected by extension.ts: recent-session data for the sidebar switcher. */
  public chatListSource:
    | (() => {
        items: Array<{ path: string; displayName: string; modifiedAt: number }>;
        others: Array<{
          path: string;
          displayName: string;
          modifiedAt: number;
          cwd: string;
          workspaceLabel: string;
        }>;
      })
    | undefined;

  private sendChatList(host: ChatHost, excludePath?: string): void {
    const source = this.chatListSource?.();
    const relative = (at: number): string => {
      const mins = Math.max(1, Math.round((Date.now() - at) / 60_000));
      if (mins < 60) {
        return `${mins}m`;
      }
      if (mins < 60 * 24) {
        return `${Math.round(mins / 60)}h`;
      }
      return `${Math.round(mins / (60 * 24))}d`;
    };
    const currentFile =
      this.sidebarTarget?.kind === 'sessionFile' ? this.sidebarTarget.sessionFile : undefined;
    host.post({
      type: 'chatList',
      current: (source?.items ?? [])
        .filter((item) => item.path !== excludePath)
        .slice(0, 30)
        .map((item) => ({
          path: item.path,
          title: item.displayName,
          time: relative(item.modifiedAt),
          current: item.path === currentFile,
        })),
      others: (source?.others ?? [])
        .filter((item) => item.path !== excludePath)
        .slice(0, 20)
        .map((item) => ({
          path: item.path,
          title: item.displayName,
          time: relative(item.modifiedAt),
          workspace: item.workspaceLabel,
          cwd: item.cwd,
        })),
    });
  }

  /** Mount the sidebar chat view onto the shared pipeline. */
  public async attachSidebarChat(
    extensionUri: vscode.Uri,
    view: vscode.WebviewView
  ): Promise<void> {
    const resource = vscode.Uri.parse('piRpcSidebar://chat/main');
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      view.webview.html =
        '<html><body style="font-family:sans-serif;padding:16px">Open a folder to chat with π.</body></html>';
      return;
    }
    // Restore whatever chat was last showing here — otherwise every reload
    // silently drops you onto a blank draft, which read as "nothing restores".
    const openFolders = new Set(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString())
    );
    const saved = this.context.workspaceState.get<ChatTabTarget>(
      ChatTabManager.SIDEBAR_LAST_TARGET_KEY
    );
    this.sidebarTarget =
      saved && openFolders.has(saved.workspaceFolderUri)
        ? saved
        : {
            workspaceFolderUri: folder.uri.toString(),
            kind: 'workspaceDraft',
            draftId: 'sidebar', // constant → same session key across reloads
          };
    this.persistSidebarTarget();
    this.logger.info(
      `[sidebar] attach (restored=${Boolean(saved && openFolders.has(saved.workspaceFolderUri))}, kind=${this.sidebarTarget.kind}, draft=${this.sidebarTarget.draftId ?? ''})`
    );
    const host = new SidebarChatHost(extensionUri, view, this, resource);
    this.hosts.set(resource.toString(), host);
    this.openChatsEmitter.fire();
    // START the controller — rendering alone leaves it "Connecting…" forever
    // (editor tabs start via activateResource; the sidebar must too).
    await this.activateResource(resource, { startIfStopped: true });
    await this.renderResource(resource, { active: true });
  }

  /** Agentic Mode takes over the SAME WebviewView to show the chat list
   * instead (AgenticChatListHost, extension.ts) — it never calls
   * attachSidebarChat, so this SidebarChatHost is never constructed fresh
   * for a session already in agentic mode. But switching FROM Chat mode TO
   * Agentic mode reuses the already-resolved view, and VS Code never fires
   * onDidDispose just because a view's content was reassigned — so without
   * this, the OLD SidebarChatHost stays registered in `hosts` forever,
   * making listOpenChats() (and so the chat list itself) keep reporting a
   * chat as "open" with no tab or view actually showing it anywhere.
   * Deliberately NOT onHostDisposed: the underlying controller isn't being
   * closed, just this view wrapper — the same session may still be in use
   * via a different tab (syncSidebarModeTransition opens one for exactly
   * this reason). */
  public detachSidebarChatHost(): void {
    // Same parse+toString as attachSidebarChat's own registration — URI
    // normalization means a hand-typed string literal isn't guaranteed to
    // match the key that was actually used to store it.
    const key = vscode.Uri.parse('piRpcSidebar://chat/main').toString();
    if (this.hosts.delete(key)) {
      this.openChatsEmitter.fire();
    }
  }

  private resolveTarget(resource: vscode.Uri): ChatTabTarget | undefined {
    if (resource.scheme === 'piRpcSidebar') {
      return this.sidebarTarget;
    }
    return this.sessions.resolveTarget(resource);
  }

  private keyFor(resource: vscode.Uri): string {
    if (resource.scheme === 'piRpcSidebar') {
      // Key follows the BINDING: switching chats must resolve to that
      // session's own controller (a constant key pinned the first controller
      // forever — clicking a chat in the switcher silently did nothing).
      const target = this.sidebarTarget;
      return `piRpcSidebar:${target?.sessionFile ?? target?.draftId ?? 'main'}`;
    }
    return this.sessions.keyFor(resource);
  }

  // Each chat tab (session) owns its OWN controller + Pi process, keyed by the
  // session, so multiple chats run IN PARALLEL. (Previously every tab in a folder
  // shared one controller, so opening a 2nd chat yanked the 1st.)
  private readonly trackedControllers = new Set<SessionController>();

  private folderForUri(uri: string): vscode.WorkspaceFolder | undefined {
    const real = (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.toString() === uri);
    if (real) {
      return real;
    }
    // Foreign-project chat (opened from the sidebar's "Other projects" group):
    // synthesize a folder handle for its cwd. Controllers/the shared host only
    // use uri.fsPath + name, so this works without the folder being in the
    // workspace — and survives window reloads that restore such tabs.
    try {
      const parsed = vscode.Uri.parse(uri, true);
      if (parsed.scheme === 'file' && existsSync(parsed.fsPath)) {
        return {
          uri: parsed,
          name: basename(parsed.fsPath) || parsed.fsPath,
          index: vscode.workspace.workspaceFolders?.length ?? 0,
        };
      }
    } catch {
      /* not a parseable uri */
    }
    return undefined;
  }

  private ensureTracked(controller: SessionController): void {
    if (this.trackedControllers.has(controller)) {
      return;
    }
    this.trackedControllers.add(controller);
    this.controllerSubscriptions.push(
      controller.onDidChangeState(() => void this.onControllerChanged(controller))
    );
  }

  private contextForResource(resource: vscode.Uri): ChatTabContext | undefined {
    const target = this.resolveTarget(resource);
    if (!target) {
      return undefined;
    }
    const folder = this.folderForUri(target.workspaceFolderUri);
    if (!folder) {
      return undefined;
    }
    const controller = this.registry.getOrCreateFor(this.keyFor(resource), folder);
    this.ensureTracked(controller);
    // Remember which tab to repaint when THIS controller changes (its session may
    // move under it after an edit/fork, but it still belongs to this tab).
    this.sessions.setOwner(controller, resource);
    return { controller, resource, target };
  }

  private nextSequence(resource: vscode.Uri): number {
    const key = this.keyFor(resource);
    const next = (this.resourceSequence.get(key) ?? 0) + 1;
    this.resourceSequence.set(key, next);
    return next;
  }

  /** The tab identity OWNED by this controller (per-tab model), if any. */
  public identityForController(controller: SessionController): ChatTabTarget | undefined {
    const owner = this.sessions.ownerOf(controller);
    return owner ? (parseChatUri(owner) ?? undefined) : undefined;
  }

  private async onControllerChanged(controller: SessionController): Promise<void> {
    this.lastActivityAt.set(controller, Date.now());

    this.detectTurnCompletion(controller);
    // Restore the draft under the OWNING TAB's identity — not the controller's
    // current-session identity, which drifts after forks/prewarm-adoption and
    // could resurrect stale text captured under the other identity.
    const ownerIdentity = this.identityForController(controller);
    if (ownerIdentity) {
      await this.uiState.restoreControllerDraftForIdentity(controller, ownerIdentity);
    } else {
      await this.uiState.restoreControllerDraft(controller);
    }
    // Repaint the tab that OWNS this controller — by its resource, NOT by the
    // controller's current session. After an edit/fork the controller's session
    // changes, but the SAME tab must keep showing it (no new chat).
    const owner = this.sessions.ownerOf(controller);
    if (owner) {
      await this.renderResource(owner);
    }
  }

  /**
   * Notify when Pi finishes a *long* turn while the user isn't watching this
   * chat. Tracks the busy->ready transition; skips quick turns and skips when
   * the chat is the focused, active tab.
   */
  private detectTurnCompletion(controller: SessionController): void {
    const now = controller.snapshot.connectionState;
    const prev = this.lastConnState.get(controller);
    this.lastConnState.set(controller, now);
    if (prev !== 'busy' && now === 'busy') {
      this.busySince.set(controller, Date.now());
      if (getSettings().turnReview) {
        void this.turnReview?.onTurnStart(controller);
      }
      return;
    }
    if (prev === 'busy' && now === 'ready') {
      const startedAt = this.busySince.get(controller);
      this.busySince.delete(controller);
      const ownerResource = this.sessions.ownerOf(controller);
      const ownerHost = ownerResource ? this.hosts.get(ownerResource.toString()) : undefined;
      // "Watching" = the window is focused AND this chat is visible anywhere —
      // active editor tab OR the sidebar surface. Watched chats stay silent.
      const watching =
        vscode.window.state.focused &&
        (this.getActiveContext()?.controller === controller || ownerHost?.panel.visible === true);
      if (getSettings().turnReview) {
        void this.turnReview?.onTurnEnd(controller, { silent: watching });
      }
      // Context pressure costs one get_session_stats RPC — only spend it on
      // chats someone can actually SEE (hidden tabs get checked on reveal).
      if (this.sessions.ownerOf(controller)) {
        const owner = this.sessions.ownerOf(controller);
        const host = owner ? this.hosts.get(owner.toString()) : undefined;
        if (host?.panel.visible) {
          void this.checkContextPressure(controller);
        }
      }
      const elapsed = startedAt ? Date.now() - startedAt : 0;
      if (!getSettings().notifyOnComplete || elapsed < 4000 || watching) {
        return;
      }
      const label = basename(controller.folder.uri.fsPath) || 'workspace';
      notifier.notify({
        kind: 'completed',
        title: `'${label}'`,
        open: () =>
          void this.openCurrentChat({
            folderUri: controller.folder.uri.toString(),
            focusComposer: true,
          }),
      });
    }
  }

  /** True if a chat editor is currently open for this controller's folder. */
  public hasOpenChatFor(controller: SessionController): boolean {
    for (const host of this.hosts.values()) {
      if (this.contextForResource(host.resource)?.controller === controller) {
        return true;
      }
    }
    return false;
  }

  /** Append text to the ACTIVE chat's draft (composer) and repaint it. */
  public async appendToActiveDraft(text: string): Promise<void> {
    const context = this.getActiveContext();
    if (!context) {
      void vscode.window.showInformationMessage('Open a Pi chat first.');
      return;
    }
    const state = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    state.draft = `${state.draft ?? ''}${text}`;
    await this.uiState.setComposerStateForIdentity(context.controller, context.target, state);
    await this.renderResource(context.resource, { active: true });
  }

  /** Open the find bar in the ACTIVE chat tab (jump-to-reference search). */
  public openFindInActiveChat(): void {
    for (const host of this.hosts.values()) {
      if (host.panel.active) {
        void host.panel.webview.postMessage({ type: 'find' });
        return;
      }
    }
    void vscode.window.showInformationMessage('Open a Pi chat first.');
  }

  /** Every open chat tab with its controller — the Mission Control roster. */
  public listOpenChats(): Array<{
    resource: vscode.Uri;
    controller: SessionController;
    title: string;
    visible: boolean;
  }> {
    const chats: Array<{
      resource: vscode.Uri;
      controller: SessionController;
      title: string;
      visible: boolean;
    }> = [];
    for (const host of this.hosts.values()) {
      const context = this.contextForResource(host.resource);
      if (!context) {
        continue;
      }
      const sessionName = context.controller.snapshot.state.sessionName;
      const title =
        (typeof sessionName === 'string' && sessionName.trim()) || host.panel.title || 'Chat';
      chats.push({
        resource: host.resource,
        controller: context.controller,
        title,
        visible: host.panel.visible,
      });
    }
    return chats;
  }

  public isControllerVisible(controller: SessionController): boolean {
    for (const host of this.hosts.values()) {
      if (host.panel.visible && this.contextForResource(host.resource)?.controller === controller) {
        return true;
      }
    }
    return false;
  }

  public revealController(controller: SessionController): void {
    for (const host of this.hosts.values()) {
      if (this.contextForResource(host.resource)?.controller === controller) {
        host.panel.reveal(undefined, false);
        return;
      }
    }
  }

  /** Re-render every open chat tab (e.g. after a presentation setting change). */
  public async rerenderAll(): Promise<void> {
    for (const host of this.hosts.values()) {
      await this.renderResource(host.resource);
    }
  }

  /** Coalesced render: Pi v0.87 streams hundreds of events/sec and a full
   * render per event melted the extension host (12s timer drift — follow
   * opened files long after turns ended). Leading edge renders instantly;
   * further events within the window collapse into ONE trailing render. */
  private readonly pendingRender = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; resolvers: Array<() => void>; active: boolean }
  >();
  private readonly lastRenderAt = new Map<string, number>();

  private async renderResource(
    resource: vscode.Uri,
    options?: { active?: boolean }
  ): Promise<void> {
    const key = resource.toString();
    const entry = this.pendingRender.get(key);
    const active = (options?.active ?? false) || (entry?.active ?? false);
    if (!entry && Date.now() - (this.lastRenderAt.get(key) ?? 0) > 50) {
      this.lastRenderAt.set(key, Date.now());
      return this.renderResourceNow(resource, options);
    }
    return new Promise((resolve) => {
      const pending = entry ?? { timer: setTimeout(() => undefined, 0), resolvers: [], active };
      clearTimeout(pending.timer);
      pending.active = active;
      pending.resolvers.push(resolve);
      pending.timer = setTimeout(() => {
        this.pendingRender.delete(key);
        this.lastRenderAt.set(key, Date.now());
        void this.renderResourceNow(resource, { active: pending.active }).finally(() => {
          for (const done of pending.resolvers) {
            done();
          }
        });
      }, 50);
      this.pendingRender.set(key, pending);
    });
  }

  private async renderResourceNow(
    resource: vscode.Uri,
    options?: { active?: boolean }
  ): Promise<void> {
    const context = this.contextForResource(resource);
    if (!context) {
      return;
    }
    const snapshot = await this.buildSnapshot(context, options?.active ?? false);
    const sharingInfo = this.remoteSharing.sharingInfoFor(resource);
    if (sharingInfo) {
      snapshot.sharing = sharingInfo;
    }
    snapshot.surface = resource.scheme === 'piRpcSidebar' ? 'sidebar' : 'tab';

    snapshot.reviewCount = this.turnReview?.history.length ?? 0;
    snapshot.followMode = vscode.workspace
      .getConfiguration('piRpc')
      .get<'open' | 'status' | 'off'>('followAgent', 'open');
    snapshot.requireApprovalForEdits = vscode.workspace
      .getConfiguration('piRpc')
      .get<boolean>('requireApprovalForEdits', false);
    snapshot.activeSessionCount = sharedPiHostActiveSessionCount();
    const title = this.titleForContext(context, snapshot);
    const host = this.hosts.get(resource.toString());
    if (host) {
      this.follow.logger = this.logger;
      this.follow.handleSnapshot(
        this.keyFor(resource),
        title,
        snapshot,
        // The pane follows the chat the user can SEE (visible ≠ focused —
        // focus stays wherever the user is typing). Live updates arrive with
        // active:false, so the render-path flag was never the right signal.
        host.panel.visible,
        safeFsPath(context.target.workspaceFolderUri) ??
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        (payload) => void host.panel.webview.postMessage(payload),
        snapshot.connectionState === 'busy' || snapshot.isStreaming === true
      );
      await host.postSnapshot(snapshot, title);
      // Mirror the active chat to a remote session, if one is running.
      if (options?.active ?? false) {
        this.remoteSharing.pushSnapshot(snapshot);
      }
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
    const folders = workspaceFolders(context.controller.folder.uri.toString());
    const composer = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    const currentTarget = currentTargetForController(context.controller);
    // Per-tab controllers are DEDICATED to their tab, so the owning tab must
    // always render the controller's LIVE state — even while the tab's identity
    // (workspaceDraft / old session) drifts from the controller's current session
    // (prewarm-adopted drafts arrive with a sessionFile; edits fork to a new
    // file). The old sameTarget-only check dropped such tabs onto a cached
    // placeholder — a New Chat that adopted the prewarmed session showed
    // "Connecting to Pi…" forever while its controller was READY.
    const isCurrent =
      sameTarget(currentTarget, context.target) ||
      this.sessions.ownerOf(context.controller)?.toString() === context.resource.toString();

    if (isCurrent) {
      const settings = getSettings();
      const snapshot = createWebviewSnapshot(context.controller.snapshot, sequence, {
        uiMode: this.uiState.getMode(),
        composer,
        isTrusted: vscode.workspace.isTrusted,
        folders,
        messageLimit: this.revealedMessageCountFor(context.resource),
        presentation: {
          workingAnimation: settings.workingAnimation,
          chatFontFamily: settings.chatFontFamily,
          chatFontSize: settings.chatFontSize,
          typewriterSpeed: settings.typewriterSpeed,
        },
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
    // BIND the draft tab to its new session IN PLACE. The old flow opened a new
    // tab for the session URI and closed the draft — a visible open/close
    // flicker on every first message. The tab now keeps its draft URI forever;
    // resolveTarget() maps it to the session (persisted across reloads).
    const oldKey = this.keyFor(from);
    const nextTarget = parseChatUri(to) ?? currentTargetForController(controller);
    this.sessions.bind(from, nextTarget);
    this.registry.rekey(oldKey, this.keyFor(from));
    this.sessions.setOwner(controller, from);
    const fromState = this.cache.get(from);
    if (fromState) {
      await this.cache.set({
        ...fromState,
        target: nextTarget,
        lastViewedAt: Date.now(),
      });
    }
    await this.renderResource(from, { active: true });
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

  /** #image-paste — attach an image pasted into the composer (base64 bytes). */
  private async addPastedImage(
    context: ChatTabContext,
    resource: vscode.Uri,
    data: string,
    mimeType: string
  ): Promise<void> {
    const settings = getSettings();
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) {
      return;
    }
    if (bytes.length > settings.maxImageBytes) {
      void vscode.window.showWarningMessage(
        'Pasted image exceeds the configured image size limit.'
      );
      return;
    }
    const state = await this.uiState.getComposerStateForIdentity(
      context.controller,
      context.target
    );
    if (state.pendingImages.length >= settings.maxImagesPerPrompt) {
      void vscode.window.showWarningMessage(
        `You can attach at most ${settings.maxImagesPerPrompt} images per message.`
      );
      return;
    }
    const extension = mimeType.split('/')[1] ?? 'png';
    const item: PendingImageItem = {
      itemId: makeId('image'),
      name: `pasted-${Date.now()}.${extension}`,
      mimeType,
      sizeBytes: bytes.length,
      inMemoryBase64: data,
      previewDataUrl: `data:${mimeType};base64,${data}`,
    };
    await this.uiState.addImageItemsForIdentity(context.controller, context.target, [item]);
    await this.renderResource(resource);
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
}

/** Normalize chat tab labels. VS Code sizes tabs by label text, so uneven
 * titles make the strip look ragged/squeezed. 'consistent' mode truncates
 * long titles with an ellipsis and pads short ones with figure spaces
 * (U+2007 — digit-width, non-collapsing) so every π tab renders near-equal. */
export function formatTabTitle(raw: string): string {
  const { mode, width } = tabTitleSettings();
  const title = raw.replace(/\s+/g, ' ').trim() || 'π Chat';
  if (mode === 'full') {
    return title;
  }
  if (title.length > width) {
    return `${title.slice(0, Math.max(1, width - 1)).trimEnd()}…`;
  }
  return title + '\u2007'.repeat(width - title.length);
}

function safeFsPath(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  try {
    return vscode.Uri.parse(uri, true).fsPath;
  } catch {
    return undefined;
  }
}
