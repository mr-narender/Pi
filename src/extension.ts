import * as vscode from 'vscode';
import { COMMAND_IDS, CONTRIBUTED_COMMANDS } from './config/commands';
import { getSettings } from './config/settings';
import { createRedactedDiagnosticsExport } from './diagnostics/export';
import { DiagnosticsLogger } from './diagnostics/logger';
import { redactJsonValue } from './diagnostics/redaction';
import { ensureWorkspaceAvailable, ensureTrustedForMutation } from './security/trust';
import { RecentSessionService } from './sessions/recentSessionService';
import { formatRelativeTimestamp } from './sessions/recentSessions';
import { SessionRegistry } from './sessions/sessionRegistry';
import { ExtensionUiBroker } from './ui/extensionUiBroker';
import { LocalExtensionUiContext } from './ui/localExtensionUi';
import { openPathInNewWindow } from './ui/navigation';
import { SessionsWebviewProvider } from './ui/sidebar/sessionsWebview';
import { SessionDirWatcher } from './sessions/sessionDirWatcher';
import { StatusBarController } from './ui/status/statusBar';
import { ChatPanelProvider } from './webview/provider';
import { ChatUiState } from './webview/composerState';
import { ChatEditorProvider } from './editorTabs/provider';
import { ChatFileSystemProvider } from './editorTabs/fileSystemProvider';
import { initChatUriRegistry } from './editorTabs/uriRegistry';
import { ChatTabManager } from './editorTabs/tabManager';
import type { SessionController } from './sessions/sessionController';
import type { ExtensionUiRequest, JsonObject } from './rpc/protocol';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function appendSessionInfoName(sessionPath: string, name: string): Promise<void> {
  const { readFile, appendFile } = await import('node:fs/promises');
  let parentId: string | null = null;
  try {
    const text = await readFile(sessionPath, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i] as string) as { id?: unknown };
        if (typeof obj.id === 'string') {
          parentId = obj.id;
          break;
        }
      } catch {
        /* skip unparseable line */
      }
    }
  } catch {
    /* new or unreadable file */
  }
  const id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const entry = {
    type: 'session_info',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    name,
  };
  await appendFile(sessionPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 1000)}K`;
  }
  return String(count);
}

function recentRequests(controller: SessionController, method?: ExtensionUiRequest['method']) {
  return controller.snapshot.uiHistory
    .filter((item) => (method ? item.method === method : true))
    .map((item) => item.data);
}

function compatibilityEvents(controller: SessionController) {
  return controller.snapshot.eventHistory
    .filter((item) => item.data.compatibility === true)
    .map((item) => ({
      id: item.id,
      type: item.type,
      timestamp: item.timestamp,
      data: redactJsonValue(item.data),
    }));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new DiagnosticsLogger();
  const registry = new SessionRegistry(logger);
  const settings = getSettings();
  const editorTabsEnabled = () => getSettings().editorTabsEnabled;
  const statusBar = new StatusBarController();
  const recentSessions = new RecentSessionService();
  const uiState = new ChatUiState(context);
  const chat = new ChatPanelProvider(context, registry, uiState);
  // Rehydrate the chat URI short-id map before any custom-editor tab is
  // restored, so restored tabs resolve to their session identity.
  initChatUriRegistry(context.workspaceState);
  const chatTabs = new ChatTabManager(context, registry, uiState, logger);
  const chatEditorProvider = new ChatEditorProvider(chatTabs);
  const broker = new ExtensionUiBroker(registry, uiState);
  const localUi = new LocalExtensionUiContext();

  context.subscriptions.push(
    logger,
    registry,
    statusBar,
    recentSessions,
    uiState,
    chat,
    chatTabs,
    broker,
    ChatFileSystemProvider.register(),
    vscode.window.registerCustomEditorProvider('piRpc.chatEditor', chatEditorProvider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const controller = registry.getOrCreate(folder);
    broker.track(controller);
    chatTabs.trackController(controller);
  }
  statusBar.setMode(uiState.getMode());
  statusBar.bind(registry.getActive());
  void recentSessions.refresh();

  // Warm-start Pi for every workspace folder as soon as the extension activates
  // so the RPC connection is already live and clicking "New Chat" opens an
  // interactive composer instantly instead of connecting on demand.
  const warmFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of warmFolders) {
    const controller = registry.getOrCreate(folder);
    if (controller.snapshot.connectionState === 'stopped') {
      logger.info(`Warm-starting Pi for '${folder.name}' on activation`);
      void controller.start().catch((error) => {
        logger.error(`Warm-start of Pi failed for '${folder.name}'`, error);
      });
    }
  }

  const sessionsView = new SessionsWebviewProvider(context.extensionUri, registry, recentSessions);

  // Keep the chat list in sync with the terminal (TUI): watch the on-disk
  // sessions dir and refresh live when Pi writes to it from a terminal.
  const sessionDirWatcher = new SessionDirWatcher(registry, recentSessions, logger);
  sessionDirWatcher.start();

  context.subscriptions.push(
    sessionDirWatcher,
    vscode.window.registerWebviewViewProvider(SessionsWebviewProvider.viewType, sessionsView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    recentSessions.onDidChange(() => sessionsView.refresh())
  );

  const refreshViews = (): void => {
    sessionsView.refresh();
    statusBar.setMode(uiState.getMode());
    statusBar.bind(registry.getActive());
    if (editorTabsEnabled()) {
      void chatTabs.refreshVisibleTabs();
    } else {
      void chat.refresh();
    }
  };

  for (const controller of registry.list()) {
    context.subscriptions.push(controller.onDidChangeState(refreshViews));
  }

  // Never open JSON/Markdown editors for information. Show a notification and
  // offer to copy the raw JSON to the clipboard for anyone who wants the detail.
  // Fire-and-forget so callers that await it never block on the notification's
  // button (which would hang in a headless/non-interactive host).
  const showJson = (title: string, data: unknown): void => {
    void vscode.window.showInformationMessage(`Pi — ${title}`, 'Copy JSON').then((choice) => {
      if (choice === 'Copy JSON') {
        void vscode.env.clipboard.writeText(JSON.stringify(data, null, 2));
        void vscode.window.showInformationMessage('Copied to clipboard.');
      }
    });
  };

  const pickRecentSession = async (
    controller: SessionController,
    title = 'Resume Chat'
  ): Promise<{ sessionPath: string; label: string } | undefined> => {
    let state = recentSessions.getState(controller.folder);
    if (!state.loading && state.items.length === 0 && !state.error) {
      await recentSessions.refresh(controller.folder);
      state = recentSessions.getState(controller.folder);
    }
    if (state.loading) {
      await recentSessions.refresh(controller.folder);
      state = recentSessions.getState(controller.folder);
    }
    if (state.error) {
      throw new Error(`Unable to read recent chats: ${state.error}`);
    }
    if (state.items.length === 0) {
      void vscode.window.showInformationMessage(
        'No saved Pi chats were found for this workspace yet.'
      );
      return undefined;
    }
    const currentSessionPath = asString(controller.snapshot.state.sessionFile);
    const picked = await vscode.window.showQuickPick(
      state.items.map((session) => ({
        label: session.displayName,
        description: [
          session.workspaceLabel,
          formatRelativeTimestamp(session.modifiedAt),
          session.modelLabel,
          currentSessionPath === session.path ? 'Current' : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
        detail: session.path,
        session,
      })),
      { title, matchOnDescription: true, matchOnDetail: true }
    );
    return picked
      ? { sessionPath: picked.session.path, label: picked.session.displayName }
      : undefined;
  };

  const withController = async (
    action: (controller: SessionController) => Promise<unknown>,
    options?: { requireTrust?: boolean; autoStart?: boolean; forcePicker?: boolean }
  ): Promise<unknown> => {
    ensureWorkspaceAvailable();
    if (options?.requireTrust) {
      ensureTrustedForMutation();
    }
    if (editorTabsEnabled()) {
      const activeContext = chatTabs.getActiveContext();
      if (activeContext) {
        registry.setActive(activeContext.controller);
        statusBar.bind(activeContext.controller);
        await chatTabs.activateResource(activeContext.resource, {
          startIfStopped: options?.autoStart !== false,
        });
        const result = await action(activeContext.controller);
        refreshViews();
        return result;
      }
    }
    const controller = await registry.getSelectedOrPick({ forcePicker: options?.forcePicker });
    if (!controller) {
      return undefined;
    }
    registry.setActive(controller);
    statusBar.bind(controller);
    if (options?.autoStart !== false && controller.snapshot.connectionState === 'stopped') {
      await controller.start();
    }
    const result = await action(controller);
    refreshViews();
    return result;
  };

  // Resolve the active chat's controller WITHOUT re-rendering the webview.
  // Rendering before opening a QuickPick/InputBox lets the webview steal focus
  // back and dismiss the picker (a flicker), so menu commands use this instead.
  const activeController = (): SessionController | undefined =>
    chatTabs.getActiveContext()?.controller ?? registry.getActive();

  const registrations = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  registrations.set('piRpcInternal.selectWorkspaceFolder', async (folderUri?: unknown) => {
    const selected =
      typeof folderUri === 'string'
        ? registry.setActive(folderUri)
        : await registry.getSelectedOrPick({ forcePicker: true });
    if (selected) {
      statusBar.bind(selected);
      await recentSessions.refresh(selected.folder);
      await uiState.restoreControllerDraft(selected);
      if (editorTabsEnabled()) {
        await chatTabs.openCurrentChat({ folderUri: selected.folder.uri.toString() });
      } else {
        await chat.refresh();
      }
      refreshViews();
    }
    return selected?.folder.uri.toString();
  });

  registrations.set('piRpcInternal.filterRecentSessions', async () => {
    const controller = await registry.getSelectedOrPick({
      title: 'Choose workspace for session search',
    });
    if (!controller) {
      return undefined;
    }
    const current = recentSessions.getState(controller.folder);
    const filterText =
      (await vscode.window.showInputBox({
        title: 'Search recent sessions',
        prompt: 'Filter by session name, first prompt, workspace, model, or id.',
        value: current.filterText,
      })) ?? current.filterText;
    recentSessions.setFilter(controller.folder, filterText.trim());
    refreshViews();
    return filterText.trim();
  });

  registrations.set('piRpcInternal.clearRecentSessionFilter', async () => {
    const controller = await registry.getSelectedOrPick({
      title: 'Choose workspace to clear search',
    });
    if (!controller) {
      return undefined;
    }
    recentSessions.clearFilter(controller.folder);
    refreshViews();
    return '';
  });

  registrations.set('piRpcInternal.renameSession', async (value?: unknown) => {
    const rec = asRecord(value);
    const sessionPath = asString(rec?.sessionPath);
    if (!sessionPath) {
      return;
    }
    // Prompt FIRST (do not open a tab beforehand — that steals focus and
    // dismisses the input box).
    const current = asString(rec?.sessionLabel) ?? '';
    const name = await vscode.window.showInputBox({
      title: 'Rename chat',
      value: current,
      prompt: 'Enter a name for this chat',
    });
    if (name === undefined || name.trim() === '') {
      return;
    }
    const trimmed = name.trim();
    // If this session is the live/loaded one, rename via Pi so its in-memory
    // state updates too; otherwise write the name into the session file
    // directly (no disruption, works for any saved chat).
    const live = registry
      .list()
      .find((entry) => asString(entry.snapshot.state.sessionFile) === sessionPath);
    if (live && live.snapshot.connectionState !== 'stopped') {
      await live.renameSession(trimmed);
      await live.refreshState();
      await live.reconcile();
      await recentSessions.refresh(live.folder);
    } else {
      await appendSessionInfoName(sessionPath, trimmed);
      await recentSessions.refresh();
    }
    refreshViews();
    void vscode.window.showInformationMessage(`Renamed chat to “${trimmed}”.`);
  });

  registrations.set('piRpcInternal.deleteSession', async (value?: unknown) => {
    const node = asRecord(value);
    const sessionPath = asString(node?.sessionPath);
    if (!sessionPath) {
      return;
    }
    const label = asString(node?.sessionLabel) ?? sessionPath.split('/').pop() ?? 'this chat';
    const confirm = await vscode.window.showWarningMessage(
      `Delete chat "${label}"? This permanently removes its saved session file.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') {
      return;
    }
    await chatTabs.closeForSessionFile(sessionPath);
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(sessionPath));
    } catch {
      /* file may already be gone; still refresh the list */
    }
    await recentSessions.refresh();
    refreshViews();
  });

  registrations.set('piRpcInternal.refreshRecentSessions', async () => {
    const controller = await registry.getSelectedOrPick({
      title: 'Choose workspace to refresh recent sessions',
    });
    if (!controller) {
      return undefined;
    }
    await recentSessions.refresh(controller.folder);
    refreshViews();
    return controller.folder.uri.toString();
  });

  registrations.set('piRpcInternal.start', async () => {
    if (editorTabsEnabled()) {
      const activeContext = chatTabs.getActiveContext();
      if (activeContext) {
        await chatTabs.startResource(activeContext.resource);
        await recentSessions.refresh(activeContext.controller.folder);
        await uiState.restoreControllerDraft(activeContext.controller);
        void vscode.window.showInformationMessage(
          `Pi started for ${activeContext.controller.folder.name}`
        );
        refreshViews();
        return activeContext.controller.folder.uri.toString();
      }
    }
    return withController(
      async (controller) => {
        await controller.start();
        await controller.reconcile();
        await recentSessions.refresh(controller.folder);
        await uiState.restoreControllerDraft(controller);
        void vscode.window.showInformationMessage(`Pi started for ${controller.folder.name}`);
      },
      { autoStart: false, forcePicker: true }
    );
  });

  registrations.set('piRpcInternal.stop', async () => {
    return withController(
      async (controller) => {
        await controller.stop();
      },
      { autoStart: false }
    );
  });

  registrations.set('piRpcInternal.restart', async () => {
    return withController(
      async (controller) => {
        await controller.restart();
      },
      { autoStart: false }
    );
  });

  registrations.set('piRpcInternal.openChat', async () => {
    if (editorTabsEnabled()) {
      await chatTabs.openCurrentChat({ focusComposer: true });
      return;
    }
    await chat.show();
    await chat.focusComposer();
  });

  registrations.set('piRpc.toggleAdvancedMode', async () => {
    const mode = await uiState.toggleMode();
    statusBar.setMode(mode);
    refreshViews();
    return mode;
  });

  registrations.set('piRpcInternal.showHelp', async () => {
    const detail = [
      'New Chat: sidebar (+ New Chat) or the Command Palette.',
      'Resume: click a chat in the sidebar; rename/delete via the hover icons.',
      'Send: type and press Cmd+Enter / Ctrl+Enter.',
      'Attach: use + in the composer (file, selection, diagnostics, image).',
      'Slash commands: press / in the composer actions to insert a Pi command.',
      'Model & thinking: the model chip and More menu.',
      '',
      'Requires the Pi CLI installed and logged in (pi --version, /login).',
    ].join('\n');
    const choice = await vscode.window.showInformationMessage(
      'Pi — quick help',
      { modal: true, detail },
      'Open full README'
    );
    if (choice === 'Open full README') {
      const readme = vscode.Uri.joinPath(context.extensionUri, 'README.md');
      await vscode.commands.executeCommand('markdown.showPreview', readme);
    }
    return 'help';
  });

  registrations.set('piRpc.prompt', async (value?: unknown) => {
    if (editorTabsEnabled()) {
      const activeContext = chatTabs.getActiveContext();
      if (activeContext) {
        ensureTrustedForMutation();
        const record = asRecord(value);
        const message =
          asString(value) ??
          asString(record?.message) ??
          (await vscode.window.showInputBox({ title: 'Prompt Pi' }));
        if (message) {
          const prepared = await chatTabs.preparePromptContext(activeContext.resource);
          if (prepared) {
            await prepared.controller.prompt(message, 'prompt');
            await chatTabs.focusComposer(prepared.resource);
          }
        }
        refreshViews();
        return undefined;
      }
    }
    return withController(
      async (controller) => {
        const record = asRecord(value);
        const message =
          asString(value) ??
          asString(record?.message) ??
          (await vscode.window.showInputBox({ title: 'Prompt Pi' }));
        if (message) {
          await controller.prompt(message, 'prompt');
          if (editorTabsEnabled()) {
            await chatTabs.openCurrentChat({ focusComposer: true });
          } else {
            await chat.show();
          }
        }
      },
      { requireTrust: true }
    );
  });

  registrations.set('piRpc.steer', async (value?: unknown) => {
    if (editorTabsEnabled()) {
      const activeContext = chatTabs.getActiveContext();
      if (activeContext) {
        ensureTrustedForMutation();
        const record = asRecord(value);
        const message =
          asString(value) ??
          asString(record?.message) ??
          (await vscode.window.showInputBox({ title: 'Steer message' }));
        if (message) {
          const prepared = await chatTabs.preparePromptContext(activeContext.resource);
          await prepared?.controller.prompt(message, 'steer');
        }
        refreshViews();
        return undefined;
      }
    }
    return withController(
      async (controller) => {
        const record = asRecord(value);
        const message =
          asString(value) ??
          asString(record?.message) ??
          (await vscode.window.showInputBox({ title: 'Steer message' }));
        if (message) {
          await controller.prompt(message, 'steer');
        }
      },
      { requireTrust: true }
    );
  });

  registrations.set('piRpc.followUp', async (value?: unknown) => {
    if (editorTabsEnabled()) {
      const activeContext = chatTabs.getActiveContext();
      if (activeContext) {
        ensureTrustedForMutation();
        const record = asRecord(value);
        const message =
          asString(value) ??
          asString(record?.message) ??
          (await vscode.window.showInputBox({ title: 'Follow-up message' }));
        if (message) {
          const prepared = await chatTabs.preparePromptContext(activeContext.resource);
          await prepared?.controller.prompt(message, 'followUp');
        }
        refreshViews();
        return undefined;
      }
    }
    return withController(
      async (controller) => {
        const record = asRecord(value);
        const message =
          asString(value) ??
          asString(record?.message) ??
          (await vscode.window.showInputBox({ title: 'Follow-up message' }));
        if (message) {
          await controller.prompt(message, 'followUp');
        }
      },
      { requireTrust: true }
    );
  });

  registrations.set('piRpc.abort', async () => withController((controller) => controller.abort()));

  registrations.set('piRpc.newSession', async (value?: unknown) => {
    if (editorTabsEnabled()) {
      ensureWorkspaceAvailable();
      ensureTrustedForMutation();
      const activeContext = chatTabs.getActiveContext();
      const controller =
        activeContext?.controller ?? (await registry.getSelectedOrPick({ forcePicker: false }));
      if (!controller) {
        return undefined;
      }
      registry.setActive(controller);
      statusBar.bind(controller);
      const record = asRecord(value);
      const currentSession = asString(controller.snapshot.state.sessionFile);
      const sourceIdentity = activeContext?.target ?? {
        workspaceFolderUri: controller.folder.uri.toString(),
        kind: currentSession ? ('sessionFile' as const) : ('workspaceDraft' as const),
        sessionFile: currentSession,
        sessionId: asString(controller.snapshot.state.sessionId),
      };
      await uiState.captureControllerDraftForIdentity(controller, sourceIdentity);
      // New Chat always starts a fresh session immediately — no confirmation.
      // (Continuing from the current session as a parent stays available via the
      // `parentSession` argument for programmatic callers.)
      const parentSession = asString(record?.parentSession);
      await chatTabs.openDraftForWorkspace(controller, { focusComposer: true });
      const result = await controller.newSession(parentSession);
      await chatTabs.nameSessionIfUnnamed(controller);
      await recentSessions.refresh(controller.folder);
      await uiState.restoreControllerDraft(controller);
      await chatTabs.promoteDraftToCurrentSession(controller);
      await chatTabs.focusComposer();
      refreshViews();
      return result;
    }
    return withController(
      async (controller) => {
        const record = asRecord(value);
        const currentSession = asString(controller.snapshot.state.sessionFile);
        const composer = await uiState.getComposerState(controller);
        await uiState.captureControllerDraft(controller);
        let parentSession = asString(record?.parentSession);
        if (currentSession && !parentSession) {
          const warning =
            composer.draft.trim() ||
            composer.pendingContextItems.length ||
            composer.pendingImages.length
              ? "\n\nUnsent draft and attachments stay in the active chat tab. They won't be sent or copied."
              : '';
          const confirm = await vscode.window.showWarningMessage(
            `Start a new chat from this workspace.${warning}`,
            { modal: true },
            'Start fresh',
            'Continue from current as parent'
          );
          if (!confirm) {
            await chat.focusComposer();
            return { cancelled: true };
          }
          parentSession =
            confirm === 'Continue from current as parent' ? currentSession : undefined;
        }
        const result = await controller.newSession(parentSession);
        await recentSessions.refresh(controller.folder);
        await uiState.restoreControllerDraft(controller);
        await chat.focusComposer();
        return result;
      },
      { requireTrust: true }
    );
  });

  registrations.set('piRpc.refreshState', async () =>
    withController((controller) => controller.refreshState())
  );
  registrations.set('piRpc.refreshMessages', async () =>
    withController((controller) => controller.refreshMessages())
  );
  registrations.set('piRpc.cycleModel', async () =>
    withController((controller) => controller.cycleModel())
  );
  registrations.set('piRpc.showModels', async () => {
    const controller = activeController();
    if (!controller) {
      void vscode.window.showInformationMessage('Open a Pi chat first.');
      return undefined;
    }
    {
      const models = await controller.getAvailableModels();
      const current = asRecord(controller.snapshot.state.model);
      const currentProvider = current ? asString(current.provider) : undefined;
      const currentKey = current
        ? `${asString(current.provider)}/${asString(current.id)}`
        : undefined;

      // Group models by provider for a two-step picker: provider -> model.
      const byProvider = new Map<string, JsonObject[]>();
      for (const model of models) {
        const provider = String(model.provider ?? 'provider');
        (byProvider.get(provider) ?? byProvider.set(provider, []).get(provider)!).push(model);
      }
      const providers = Array.from(byProvider.keys()).sort();

      const modelItem = (model: JsonObject) => {
        const provider = String(model.provider ?? 'provider');
        const id = String(model.id ?? 'model');
        const key = `${provider}/${id}`;
        const inputs = Array.isArray(model.input) ? model.input.map(String) : [];
        const bits = [
          model.reasoning ? 'reasoning' : 'no reasoning',
          typeof model.contextWindow === 'number'
            ? `ctx ${formatTokenCount(model.contextWindow)}`
            : undefined,
          typeof model.maxTokens === 'number'
            ? `out ${formatTokenCount(model.maxTokens)}`
            : undefined,
          inputs.includes('image') ? 'images' : undefined,
        ].filter(Boolean);
        return {
          label: `${key === currentKey ? '$(check) ' : ''}${id}`,
          description: String(model.name ?? ''),
          detail: bits.join('  \u00b7  '),
          model,
        };
      };

      const pickModelsFrom = async (list: JsonObject[], title: string) => {
        const items = list
          .slice()
          .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
          .map(modelItem);
        return vscode.window.showQuickPick(items, {
          title,
          placeHolder: 'reasoning · context · max output · images',
          matchOnDetail: true,
        });
      };

      let picked;
      if (providers.length <= 1) {
        picked = await pickModelsFrom(models, 'Select model');
      } else {
        // Step 1: pick a provider (with an "All providers" escape hatch).
        const ALL = '$(list-flat) All providers';
        const providerPick = await vscode.window.showQuickPick(
          [
            { label: ALL, provider: undefined as string | undefined },
            ...providers.map((provider) => ({
              label: `${provider === currentProvider ? '$(check) ' : ''}${provider}`,
              description: `${byProvider.get(provider)?.length ?? 0} model(s)`,
              provider,
            })),
          ],
          { title: 'Select provider', placeHolder: 'Choose a provider, then a model' }
        );
        if (!providerPick) {
          return models;
        }
        // Step 2: pick a model within the provider (or across all).
        picked = providerPick.provider
          ? await pickModelsFrom(
              byProvider.get(providerPick.provider) ?? [],
              `${providerPick.provider} — select model`
            )
          : await pickModelsFrom(models, 'Select model');
      }

      if (picked) {
        await controller.selectModel(
          String(picked.model.provider ?? ''),
          String(picked.model.id ?? '')
        );
        await controller.refreshState();
        refreshViews();
      }
      return models;
    }
  });
  registrations.set('piRpc.selectModel', registrations.get('piRpc.showModels')!);
  registrations.set('piRpc.setThinkingLevel', async () => {
    const controller = activeController();
    if (!controller) {
      void vscode.window.showInformationMessage('Open a Pi chat first.');
      return;
    }
    const currentLevel = asString(controller.snapshot.state.thinkingLevel);
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const picked = await vscode.window.showQuickPick(
      levels.map((level) => ({
        label: `${level === currentLevel ? '$(check) ' : ''}${level}`,
        level,
      })),
      { title: 'Thinking level', placeHolder: 'How much should Pi reason before replying?' }
    );
    if (picked) {
      await controller.setThinkingLevel(picked.level);
      await controller.refreshState();
      refreshViews();
      void vscode.window.showInformationMessage(`Thinking level set to “${picked.level}”.`);
    }
  });
  registrations.set('piRpc.cycleThinkingLevel', async () =>
    withController((controller) => controller.cycleThinkingLevel())
  );
  registrations.set('piRpc.setSteeringMode', async () => {
    return withController(async (controller) => {
      const picked = await vscode.window.showQuickPick(['all', 'one-at-a-time'], {
        title: 'Steering mode',
      });
      if (picked) {
        await controller.setSteeringMode(picked);
      }
    });
  });
  registrations.set('piRpc.setFollowUpMode', async () => {
    return withController(async (controller) => {
      const picked = await vscode.window.showQuickPick(['all', 'one-at-a-time'], {
        title: 'Follow-up mode',
      });
      if (picked) {
        await controller.setFollowUpMode(picked);
      }
    });
  });
  registrations.set('piRpc.compact', async () => {
    return withController(
      async (controller) => {
        const customInstructions = await vscode.window.showInputBox({
          title: 'Compaction instructions (optional)',
        });
        return controller.compact(customInstructions);
      },
      { requireTrust: true }
    );
  });
  registrations.set('piRpc.toggleAutoCompaction', async () =>
    withController((controller) => controller.toggleAutoCompaction())
  );
  registrations.set('piRpc.toggleAutoRetry', async () => {
    return withController(async (controller) => {
      const enabled = await vscode.window.showQuickPick(['Enable', 'Disable'], {
        title: 'Auto retry',
      });
      if (enabled) {
        await controller.toggleAutoRetry(enabled === 'Enable');
      }
    });
  });
  registrations.set('piRpc.abortRetry', async () =>
    withController((controller) => controller.abortRetry())
  );
  registrations.set('piRpc.runBash', async (value?: unknown) => {
    return withController(
      async (controller) => {
        ensureTrustedForMutation();
        const record = asRecord(value);
        const command =
          asString(record?.command) ??
          (await vscode.window.showInputBox({ title: 'Run bash command' }));
        if (!command) {
          return undefined;
        }
        const excludeFromContext =
          record?.excludeFromContext === true ||
          (await vscode.window.showQuickPick(
            ['Include in next prompt context', 'Exclude from next prompt context'],
            {
              title: 'Bash result context policy',
            }
          )) === 'Exclude from next prompt context';
        const result = await controller.runBash(command, excludeFromContext);
        await showJson('bash', result ?? {});
        return result;
      },
      { requireTrust: true }
    );
  });
  registrations.set('piRpc.abortBash', async () =>
    withController((controller) => controller.abortBash())
  );
  registrations.set('piRpc.showSessionStats', async () => {
    const controller = activeController();
    if (!controller) {
      void vscode.window.showInformationMessage('Open a Pi chat first.');
      return undefined;
    }
    const stats = (await controller.showSessionStats()) ?? {};
    const tokens = asRecord(stats.tokens) ?? {};
    const ctx = asRecord(stats.contextUsage);
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    const cost = num(stats.cost);
    const lines = [
      `Messages: ${num(stats.userMessages)} you · ${num(stats.assistantMessages)} Pi`,
      `Tool calls: ${num(stats.toolCalls)}`,
      `Tokens: ${formatTokenCount(num(tokens.total))} total  (in ${formatTokenCount(
        num(tokens.input)
      )} · out ${formatTokenCount(num(tokens.output))} · cache ${formatTokenCount(
        num(tokens.cacheRead)
      )})`,
      ctx
        ? `Context: ${formatTokenCount(num(ctx.tokens))} / ${formatTokenCount(
            num(ctx.contextWindow)
          )}  (${num(ctx.percent)}%)`
        : undefined,
      `Cost: $${cost.toFixed(cost < 1 ? 4 : 2)}`,
    ].filter(Boolean) as string[];
    const choice = await vscode.window.showInformationMessage(
      'Usage & cost',
      { modal: true, detail: lines.join('\n') },
      'Copy JSON'
    );
    if (choice === 'Copy JSON') {
      await vscode.env.clipboard.writeText(JSON.stringify(stats, null, 2));
      void vscode.window.showInformationMessage('Copied usage details to clipboard.');
    }
    return stats;
  });
  registrations.set('piRpc.exportHtml', async () => {
    return withController(
      async (controller) => {
        const target = await vscode.window.showSaveDialog({ filters: { HTML: ['html'] } });
        const result = await controller.exportHtml(target?.fsPath);
        if (typeof result?.path === 'string') {
          void vscode.window.showInformationMessage(`Exported ${result.path}`);
        }
        return result;
      },
      { requireTrust: true }
    );
  });
  registrations.set('piRpc.switchSession', async (value?: unknown) => {
    if (editorTabsEnabled()) {
      ensureWorkspaceAvailable();
      ensureTrustedForMutation();
      const activeContext = chatTabs.getActiveContext();
      const controller =
        activeContext?.controller ??
        (await registry.getSelectedOrPick({
          title: 'Choose workspace for session history',
        }));
      if (!controller) {
        return undefined;
      }
      const record = asRecord(value);
      const picked =
        asString(record?.sessionPath) && asString(record?.label)
          ? {
              sessionPath: asString(record?.sessionPath)!,
              label: asString(record?.label)!,
            }
          : asString(record?.sessionPath)
            ? {
                sessionPath: asString(record?.sessionPath)!,
                label: asString(record?.label) ?? 'Saved chat',
              }
            : await pickRecentSession(controller, 'Resume Chat');
      if (!picked) {
        return { cancelled: true };
      }
      await recentSessions.refresh(controller.folder);
      const resource = await chatTabs.openForSessionFile(controller, picked.sessionPath, {
        focusComposer: true,
      });
      await chatTabs.activateResource(resource, { startIfStopped: false });
      refreshViews();
      return picked;
    }
    return withController(
      async (controller) => {
        const record = asRecord(value);
        const picked =
          asString(record?.sessionPath) && asString(record?.label)
            ? {
                sessionPath: asString(record?.sessionPath)!,
                label: asString(record?.label)!,
              }
            : asString(record?.sessionPath)
              ? {
                  sessionPath: asString(record?.sessionPath)!,
                  label: asString(record?.label) ?? 'Saved chat',
                }
              : await pickRecentSession(controller, 'Resume Chat');
        if (!picked) {
          return { cancelled: true };
        }
        const currentSession = asString(controller.snapshot.state.sessionFile);
        if (currentSession === picked.sessionPath) {
          void vscode.window.showInformationMessage(`${picked.label} is already open.`);
          return { cancelled: true, alreadyCurrent: true };
        }
        await uiState.captureControllerDraft(controller);
        if (currentSession) {
          const confirm = await vscode.window.showWarningMessage(
            `Resume ${picked.label}? Your current chat stays saved and you can come back from Resume Chat.`,
            { modal: true },
            'Resume Chat'
          );
          if (confirm !== 'Resume Chat') {
            await chat.focusComposer();
            return { cancelled: true };
          }
        }
        const result = await controller.switchSession(picked.sessionPath);
        await recentSessions.refresh(controller.folder);
        await uiState.restoreControllerDraft(controller);
        await chat.focusComposer();
        return result;
      },
      { requireTrust: true }
    );
  });
  registrations.set('piRpc.forkSession', async (value?: unknown) => {
    if (editorTabsEnabled()) {
      const activeContext = chatTabs.getActiveContext();
      if (activeContext) {
        ensureTrustedForMutation();
        const live = await chatTabs.activateResource(activeContext.resource, {
          startIfStopped: true,
        });
        if (!live) {
          return undefined;
        }
        const entryId = asString(asRecord(value)?.entryId);
        const pickForkEntryId = async (): Promise<string | undefined> => {
          if (entryId) {
            return entryId;
          }
          const entries = await live.controller.getForkMessages();
          const picked = await vscode.window.showQuickPick(
            entries.map((entry) => ({
              label: 'Start Branch',
              description: String(entry.text ?? '').slice(0, 120),
              detail: String(entry.entryId ?? 'entry'),
              entry,
            })),
            { title: 'Start Branch from User Message', matchOnDescription: true }
          );
          return typeof picked?.entry.entryId === 'string' ? picked.entry.entryId : undefined;
        };
        const chosenEntryId = await pickForkEntryId();
        if (!chosenEntryId) {
          return { cancelled: true };
        }
        await uiState.captureControllerDraftForIdentity(live.controller, live.target);
        const result = await live.controller.fork(chosenEntryId);
        await recentSessions.refresh(live.controller.folder);
        await uiState.captureControllerDraft(live.controller);
        const resource = await chatTabs.openCurrentChat({ focusComposer: true });
        refreshViews();
        return resource ? result : { cancelled: true };
      }
    }
    return withController(
      async (controller) => {
        const entryId = asString(asRecord(value)?.entryId);
        if (entryId) {
          await uiState.captureControllerDraft(controller);
          const result = await controller.fork(entryId);
          await recentSessions.refresh(controller.folder);
          await uiState.captureControllerDraft(controller);
          await chat.focusComposer();
          return result;
        }
        const entries = await controller.getForkMessages();
        const picked = await vscode.window.showQuickPick(
          entries.map((entry) => ({
            label: 'Start Branch',
            description: String(entry.text ?? '').slice(0, 120),
            detail: String(entry.entryId ?? 'entry'),
            entry,
          })),
          { title: 'Start Branch from User Message', matchOnDescription: true }
        );
        if (picked && typeof picked.entry.entryId === 'string') {
          await uiState.captureControllerDraft(controller);
          const result = await controller.fork(picked.entry.entryId);
          await recentSessions.refresh(controller.folder);
          await uiState.captureControllerDraft(controller);
          await chat.focusComposer();
          return result;
        }
        return { cancelled: true };
      },
      { requireTrust: true }
    );
  });
  registrations.set('piRpc.cloneSession', async () => {
    if (editorTabsEnabled()) {
      const activeContext = chatTabs.getActiveContext();
      if (activeContext) {
        ensureTrustedForMutation();
        const live = await chatTabs.activateResource(activeContext.resource, {
          startIfStopped: true,
        });
        if (!live) {
          return undefined;
        }
        await uiState.captureControllerDraftForIdentity(live.controller, live.target);
        const result = await live.controller.clone();
        await recentSessions.refresh(live.controller.folder);
        await uiState.captureControllerDraft(live.controller);
        await chatTabs.openCurrentChat({ focusComposer: true });
        refreshViews();
        return result;
      }
    }
    return withController(
      async (controller) => {
        await uiState.captureControllerDraft(controller);
        const result = await controller.clone();
        await recentSessions.refresh(controller.folder);
        await uiState.captureControllerDraft(controller);
        await chat.focusComposer();
        return result;
      },
      { requireTrust: true }
    );
  });
  registrations.set('piRpc.showForkMessages', async () => {
    return withController(async (controller) => {
      const entries = await controller.getForkMessages();
      await showJson('fork-messages', entries);
      return entries;
    });
  });
  registrations.set('piRpc.refreshEntries', async () =>
    withController((controller) => controller.refreshEntries())
  );
  registrations.set('piRpc.showSessionTree', async () => {
    return withController(async (controller) => {
      await controller.refreshTree();
      await showJson('tree', controller.snapshot.tree);
      return controller.snapshot.tree;
    });
  });
  registrations.set('piRpc.copyLastAssistant', async () => {
    return withController(async (controller) => {
      const text = await controller.copyLastAssistantText();
      if (text) {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage('Copied last assistant response');
      } else {
        void vscode.window.showInformationMessage('No assistant response available');
      }
      return text;
    });
  });
  registrations.set('piRpc.renameSession', async (value?: unknown) => {
    const controller = activeController();
    if (!controller) {
      void vscode.window.showInformationMessage('Open a Pi chat first.');
      return undefined;
    }
    const name =
      asString(asRecord(value)?.name) ??
      (await vscode.window.showInputBox({
        title: 'Rename chat',
        value: asString(controller.snapshot.state.sessionName) ?? '',
        prompt: 'Enter a name for this chat',
      }));
    if (name !== undefined && name.trim() !== '') {
      await controller.renameSession(name.trim());
      await controller.refreshState();
      await controller.reconcile();
      await recentSessions.refresh(controller.folder);
      refreshViews();
      void vscode.window.showInformationMessage(`Renamed chat to “${name.trim()}”.`);
    }
    return name;
  });
  registrations.set('piRpc.showPiCommands', async () => {
    const activeContext = chatTabs.getActiveContext();
    const controller = activeContext?.controller ?? registry.getActive();
    if (!controller) {
      void vscode.window.showInformationMessage('Open a Pi chat first.');
      return undefined;
    }
    const ready =
      controller.snapshot.connectionState === 'ready' ||
      controller.snapshot.connectionState === 'busy';
    if (!ready) {
      void vscode.window.showInformationMessage('Pi is still connecting… try again in a moment.');
      return undefined;
    }
    const commands = await controller.getPiCommands();
    if (commands.length === 0) {
      void vscode.window.showInformationMessage('No Pi commands are available for this session.');
      return commands;
    }
    const picked = await vscode.window.showQuickPick(
      commands.map((command) => ({
        label: `/${String(command.name ?? 'command')}`,
        description: String(command.description ?? ''),
        detail: String(command.source ?? ''),
        command,
      })),
      { title: 'Pi commands', placeHolder: 'Insert a command into the composer' }
    );
    if (picked && typeof picked.command.name === 'string') {
      // Insert into the composer so the user can add arguments and send — the
      // slash command is expanded/executed by Pi when the message is sent.
      await chatTabs.appendComposerCommand(`/${picked.command.name} `);
      await chatTabs.focusComposer();
    }
    return commands;
  });
  registrations.set('piRpc.respondExtensionUi', async () => {
    return withController(
      async (controller) => {
        const payload = {
          pending: controller.snapshot.pendingUi,
          history: controller.snapshot.uiHistory,
        };
        await showJson('extension-ui', payload);
        return payload;
      },
      { autoStart: false }
    );
  });
  registrations.set('piRpcInternal.showLogs', async () => {
    logger.show();
  });

  const adjustChatFont = async (delta: number): Promise<void> => {
    const config = vscode.workspace.getConfiguration('piRpc');
    const current = config.get<number>('chatFontSize', 0) || 13;
    const next = Math.max(9, Math.min(28, current + delta));
    await config.update('chatFontSize', next, vscode.ConfigurationTarget.Global);
  };
  registrations.set('piRpcInternal.increaseChatFont', () => adjustChatFont(1));
  registrations.set('piRpcInternal.decreaseChatFont', () => adjustChatFont(-1));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('piRpc.chatFontSize') ||
        event.affectsConfiguration('piRpc.chatFontFamily') ||
        event.affectsConfiguration('piRpc.workingAnimation')
      ) {
        void chatTabs.rerenderAll();
      }
    })
  );

  registrations.set('piRpcInternal.retryLast', async () => {
    const text = chatTabs.getLastUserPrompt();
    if (!text) {
      void vscode.window.showInformationMessage('Pi: no message to retry.');
      return;
    }
    await withController((controller) => controller.prompt(text), { requireTrust: true });
  });

  registrations.set('piRpcInternal.copyConversationMarkdown', async () => {
    const result = chatTabs.getActiveConversationMarkdown();
    if (!result) {
      void vscode.window.showInformationMessage('Pi: open a chat to copy it.');
      return;
    }
    await vscode.env.clipboard.writeText(result.markdown);
    void vscode.window.showInformationMessage('Pi: conversation copied as Markdown.');
  });

  registrations.set('piRpcInternal.showHealth', async () => {
    const controller = registry.getActive();
    const health = createRedactedDiagnosticsExport(logger, controller);
    const state = controller?.snapshot;
    const model = asRecord(state?.state.model);
    const modelLabel = model
      ? `${asString(model.provider) ?? '?'}/${asString(model.id) ?? '?'}`
      : 'not selected';
    const lines = [
      `Connection: ${state?.connectionState ?? 'no active chat'}`,
      `Workspace: ${controller?.folder.name ?? '—'}`,
      `Session: ${asString(state?.state.sessionName) ?? '—'}`,
      `Model: ${modelLabel}`,
      `Thinking: ${asString(state?.state.thinkingLevel) ?? '—'}`,
      `Messages: ${state?.messages.length ?? 0}`,
      `Pi path: ${getSettings().executable}`,
    ];
    const choice = await vscode.window.showInformationMessage(
      'Pi connection health',
      { modal: true, detail: lines.join('\n') },
      'Copy diagnostics'
    );
    if (choice === 'Copy diagnostics') {
      await vscode.env.clipboard.writeText(JSON.stringify(health, null, 2));
      void vscode.window.showInformationMessage('Redacted diagnostics copied to clipboard.');
    }
    return health;
  });
  registrations.set('piRpcInternal.exportDiagnostics', async () => {
    ensureTrustedForMutation();
    const target = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] } });
    if (!target) {
      return undefined;
    }
    const payload = createRedactedDiagnosticsExport(logger, registry.getActive());
    await vscode.workspace.fs.writeFile(
      target,
      Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
    );
    void vscode.window.showInformationMessage(`Exported diagnostics to ${target.fsPath}`);
    return target.fsPath;
  });
  registrations.set('piRpcInternal.openWorktree', async () => {
    ensureTrustedForMutation();
    const path = await vscode.window.showInputBox({ title: 'Open worktree directory' });
    if (path) {
      await openPathInNewWindow(path);
    }
    return path;
  });

  const inspectEvent = (type: string) => async () =>
    withController(
      async (controller) => {
        const payload = controller.snapshot.eventHistory.filter((event) => event.type === type);
        await showJson(type, payload);
        return payload;
      },
      { autoStart: false }
    );

  registrations.set('piRpc.inspectAgentStart', inspectEvent('agent_start'));
  registrations.set('piRpc.inspectAgentEnd', inspectEvent('agent_end'));
  registrations.set('piRpc.inspectAgentSettled', inspectEvent('agent_settled'));
  registrations.set('piRpc.inspectTurnStart', inspectEvent('turn_start'));
  registrations.set('piRpc.inspectTurnEnd', inspectEvent('turn_end'));
  registrations.set('piRpc.inspectMessageStart', inspectEvent('message_start'));
  registrations.set('piRpc.inspectMessageUpdate', inspectEvent('message_update'));
  registrations.set('piRpc.inspectMessageEnd', inspectEvent('message_end'));
  registrations.set('piRpc.inspectToolStart', inspectEvent('tool_execution_start'));
  registrations.set('piRpc.inspectToolUpdate', inspectEvent('tool_execution_update'));
  registrations.set('piRpc.inspectToolEnd', inspectEvent('tool_execution_end'));
  registrations.set('piRpc.inspectQueueUpdate', inspectEvent('queue_update'));
  registrations.set('piRpc.inspectCompactionStart', inspectEvent('compaction_start'));
  registrations.set('piRpc.inspectCompactionEnd', inspectEvent('compaction_end'));
  registrations.set('piRpc.inspectRetryStart', inspectEvent('auto_retry_start'));
  registrations.set('piRpc.inspectRetryEnd', inspectEvent('auto_retry_end'));
  registrations.set('piRpc.inspectEntryAppended', inspectEvent('entry_appended'));
  registrations.set('piRpc.inspectSessionInfoChanged', inspectEvent('session_info_changed'));
  registrations.set('piRpc.inspectThinkingChanged', inspectEvent('thinking_level_changed'));
  registrations.set('piRpc.inspectExtensionError', async () =>
    withController(
      async (controller) => {
        const payload = controller.snapshot.diagnostics.filter((item) =>
          item.message.includes('Extension')
        );
        await showJson('extension-errors', payload);
        return payload;
      },
      { autoStart: false }
    )
  );
  registrations.set('piRpc.inspectCompatibilityEvents', async () =>
    withController(
      async (controller) => {
        const payload = compatibilityEvents(controller);
        await showJson('compatibility-events', payload);
        return payload;
      },
      { autoStart: false }
    )
  );
  registrations.set('piRpc.inspectRpcError', async () =>
    withController(
      async (controller) => {
        const payload = controller.snapshot.diagnostics.filter((item) =>
          item.message.includes('RPC response failed')
        );
        await showJson('rpc-errors', payload);
        return payload;
      },
      { autoStart: false }
    )
  );
  registrations.set('piRpc.inspectParseError', async () =>
    withController(
      async (controller) => {
        const payload = controller.snapshot.diagnostics.filter(
          (item) => item.message.includes('parse') || item.detail?.includes('parse')
        );
        await showJson('parse-errors', payload);
        return payload;
      },
      { autoStart: false }
    )
  );

  const previewRequest = async (
    method: ExtensionUiRequest['method'],
    seed: (controller: SessionController, value?: unknown) => Promise<ExtensionUiRequest>
  ) =>
    withController(
      async (controller) => {
        const request = await seed(controller);
        const result = await broker.previewRequest(controller, request);
        await showJson(`extension-ui-${method}`, {
          recent: recentRequests(controller, method),
          result,
        });
        return result;
      },
      { autoStart: false }
    );

  registrations.set('piRpc.extensionUi.select', async () =>
    previewRequest('select', async (controller) => ({
      type: 'extension_ui_request',
      id: `preview-select-${Date.now()}`,
      method: 'select',
      title: 'Pi preview select',
      options: recentRequests(controller, 'select').at(-1)?.options ?? [
        'Open session tree',
        'Show models',
        'Cancel',
      ],
      timeout: 5000,
    }))
  );
  registrations.set('piRpc.extensionUi.confirm', async () =>
    previewRequest('confirm', async () => ({
      type: 'extension_ui_request',
      id: `preview-confirm-${Date.now()}`,
      method: 'confirm',
      title: 'Pi preview confirm',
      message: 'Confirm a preview action',
      timeout: 5000,
    }))
  );
  registrations.set('piRpc.extensionUi.input', async () =>
    previewRequest('input', async () => ({
      type: 'extension_ui_request',
      id: `preview-input-${Date.now()}`,
      method: 'input',
      title: 'Pi preview input',
      placeholder: 'type a value',
      timeout: 5000,
    }))
  );
  registrations.set('piRpc.extensionUi.editor', async () =>
    previewRequest('editor', async () => ({
      type: 'extension_ui_request',
      id: `preview-editor-${Date.now()}`,
      method: 'editor',
      title: 'Pi preview editor',
      prefill: registry.getActive()?.snapshot.draft ?? '',
    }))
  );
  registrations.set('piRpc.extensionUi.notify', async () =>
    previewRequest('notify', async () => ({
      type: 'extension_ui_request',
      id: `preview-notify-${Date.now()}`,
      method: 'notify',
      message: 'Pi preview notification',
      notifyType: 'info',
    }))
  );
  registrations.set('piRpc.extensionUi.setStatus', async (value?: unknown) =>
    withController(
      async (controller) => {
        const record = asRecord(value);
        const key =
          asString(record?.key) ?? (await vscode.window.showInputBox({ title: 'Status key' }));
        if (!key) {
          return undefined;
        }
        const text =
          'text' in (record ?? {})
            ? (asString(record?.text) ?? '')
            : ((await vscode.window.showInputBox({ title: 'Status text (blank clears)' })) ?? '');
        const request: ExtensionUiRequest = {
          type: 'extension_ui_request',
          id: `preview-status-${Date.now()}`,
          method: 'setStatus',
          statusKey: key,
          statusText: text || undefined,
        };
        controller.applyExtensionUiRequest(request);
        await showJson('status', {
          statuses: controller.snapshot.statuses,
          recent: recentRequests(controller, 'setStatus'),
        });
        return controller.snapshot.statuses;
      },
      { autoStart: false }
    )
  );
  registrations.set('piRpc.extensionUi.setWidget', async (value?: unknown) =>
    withController(
      async (controller) => {
        const record = asRecord(value);
        const key =
          asString(record?.key) ?? (await vscode.window.showInputBox({ title: 'Widget key' }));
        if (!key) {
          return undefined;
        }
        const placement =
          asString(record?.placement) === 'belowEditor' ? 'belowEditor' : 'aboveEditor';
        const linesValue =
          asString(record?.lines) ??
          (await vscode.window.showInputBox({ title: 'Widget lines (use | as separator)' }));
        const request: ExtensionUiRequest = {
          type: 'extension_ui_request',
          id: `preview-widget-${Date.now()}`,
          method: 'setWidget',
          widgetKey: key,
          widgetLines: linesValue
            ? linesValue
                .split(/\r?\n|\|/)
                .map((item) => item.trim())
                .filter(Boolean)
            : undefined,
          widgetPlacement: placement,
        };
        controller.applyExtensionUiRequest(request);
        await showJson('widget', {
          widgets: controller.snapshot.widgets,
          recent: recentRequests(controller, 'setWidget'),
        });
        return controller.snapshot.widgets;
      },
      { autoStart: false }
    )
  );
  registrations.set('piRpc.extensionUi.setTitle', async (value?: unknown) =>
    withController(
      async (controller) => {
        const title =
          asString(asRecord(value)?.title) ??
          (await vscode.window.showInputBox({ title: 'Chat title' }));
        if (!title) {
          return undefined;
        }
        controller.applyExtensionUiRequest({
          type: 'extension_ui_request',
          id: `preview-title-${Date.now()}`,
          method: 'setTitle',
          title,
        });
        if (editorTabsEnabled()) {
          await chatTabs.refreshVisibleTabs();
        } else {
          await chat.refresh();
        }
        return controller.snapshot.title;
      },
      { autoStart: false }
    )
  );
  registrations.set('piRpc.extensionUi.setEditorText', async (value?: unknown) =>
    withController(
      async (controller) => {
        const text =
          asString(asRecord(value)?.text) ??
          (await vscode.window.showInputBox({ title: 'Draft text' }));
        if (text === undefined) {
          return undefined;
        }
        const request: ExtensionUiRequest = {
          type: 'extension_ui_request',
          id: `preview-set-editor-${Date.now()}`,
          method: 'set_editor_text',
          text,
        };
        return broker.previewRequest(controller, request);
      },
      { requireTrust: true, autoStart: false }
    )
  );

  const capability = async (title: string, data: unknown): Promise<unknown> => {
    await showJson(title, data);
    return data;
  };

  registrations.set('piRpc.extensionUiLocal.onTerminalInput', async () =>
    capability('onTerminalInput', { disposer: typeof localUi.onTerminalInput().dispose })
  );
  registrations.set('piRpc.extensionUiLocal.setWorkingMessage', async () =>
    capability('setWorkingMessage', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.setWorkingVisible', async () =>
    capability('setWorkingVisible', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.setWorkingIndicator', async () =>
    capability('setWorkingIndicator', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.setHiddenThinkingLabel', async () =>
    capability('setHiddenThinkingLabel', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.setFooter', async () =>
    capability('setFooter', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.setHeader', async () =>
    capability('setHeader', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.custom', async () =>
    capability('custom', await localUi.custom())
  );
  registrations.set('piRpc.extensionUiLocal.pasteToEditor', async () =>
    withController(
      async (controller) => {
        const request = localUi.pasteToEditor(controller, 'Pasted from compatibility surface');
        if (editorTabsEnabled()) {
          await chatTabs.refreshVisibleTabs();
        } else {
          await chat.refresh();
        }
        return capability('pasteToEditor', request);
      },
      { requireTrust: true, autoStart: false }
    )
  );
  registrations.set('piRpc.extensionUiLocal.getEditorText', async () =>
    capability('getEditorText', localUi.getEditorText())
  );
  registrations.set('piRpc.extensionUiLocal.addAutocompleteProvider', async () =>
    capability('addAutocompleteProvider', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.setEditorComponent', async () =>
    capability('setEditorComponent', { ignored: true })
  );
  registrations.set('piRpc.extensionUiLocal.getEditorComponent', async () =>
    capability('getEditorComponent', localUi.getEditorComponent())
  );
  registrations.set('piRpc.extensionUiLocal.themeGetter', async () =>
    capability('themeGetter', localUi.theme)
  );
  registrations.set('piRpc.extensionUiLocal.getAllThemes', async () =>
    capability('getAllThemes', localUi.getAllThemes())
  );
  registrations.set('piRpc.extensionUiLocal.getTheme', async () =>
    capability('getTheme', localUi.getTheme())
  );
  registrations.set('piRpc.extensionUiLocal.setTheme', async () =>
    capability('setTheme', localUi.setTheme())
  );
  registrations.set('piRpc.extensionUiLocal.getToolsExpanded', async () =>
    capability('getToolsExpanded', localUi.getToolsExpanded())
  );
  registrations.set('piRpc.extensionUiLocal.setToolsExpanded', async () =>
    capability('setToolsExpanded', { ignored: true })
  );

  const missing = COMMAND_IDS.filter((id) => !registrations.has(id));
  if (missing.length > 0) {
    throw new Error(`Missing command handlers: ${missing.join(', ')}`);
  }

  for (const [id, handler] of registrations) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  const contributedIds = new Set(CONTRIBUTED_COMMANDS.map((command) => command.id));
  logger.info(
    `Registered ${registrations.size} command handlers for ${contributedIds.size} contributed commands`
  );

  const firstFolder = vscode.workspace.workspaceFolders?.[0];
  if (settings.autoStart && vscode.workspace.isTrusted && firstFolder) {
    const controller = registry.getOrCreate(firstFolder);
    broker.track(controller);
    registry.setActive(controller);
    statusBar.bind(controller);
    await controller.start();
    refreshViews();
  }
}

export function deactivate(): void {
  // VS Code disposes subscriptions.
}
