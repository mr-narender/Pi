import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { RpcTransport } from '../../src/rpc/transport';
import { RpcClient } from '../../src/rpc/client';
import { createInitialControllerState } from '../../src/state/types';
import { reduceEvent, reduceExtensionUiRequest } from '../../src/state/reducer';
import { createRedactedDiagnosticsExport } from '../../src/diagnostics/export';
import { parseWebviewMessage } from '../../src/webview/messages';
import { canonicalizeSessionPath } from '../../src/sessions/paths';
import {
  getDefaultSessionDirForWorkspace,
  readRecentSessionsIndex,
} from '../../src/sessions/recentSessions';
import { createResumeChatSidebarModel } from '../../src/ui/trees/sessionSidebarModel';
import {
  ATTACH_TRIGGER_ID,
  PREVIEW_ACCEPT_BUTTON_ID,
  PREVIEW_DESCRIPTION_ID,
  contextChipRemoveButtonId,
  focusTargetFromSnapshot,
  imageChipRemoveButtonId,
  planChipRemovalFocus,
  renderChatApp,
} from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

test('reviewer repro 1: no fallback no-op command handler remains', () => {
  const source = readFileSync('src/extension.ts', 'utf8');
  assert.ok(!source.includes('implemented as an inspect/capability surface'));
  assert.ok(source.includes('Missing command handlers'));
});

test('reviewer repro 2: executable coverage validator passes', () => {
  execFileSync('node', ['./scripts/validateCoverage.mjs'], { stdio: 'pipe' });
});

test('reviewer repro 3: reducer replaces streamed partials instead of duplicating messages', () => {
  let state = createInitialControllerState('workspace', '/tmp/workspace');
  state = reduceEvent(state, {
    type: 'message_start',
    message: { id: 'm1', role: 'assistant', content: [] },
  });
  state = reduceEvent(state, {
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
  });
  state = reduceEvent(state, {
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello', partial: {} },
  });
  state = reduceEvent(state, {
    type: 'message_end',
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  });
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.messages[0]?.content, [{ type: 'text', text: 'hello' }]);
});

test('reviewer repro 4: webview send path is trust-gated and validated', () => {
  const provider = readFileSync('src/webview/provider.ts', 'utf8');
  assert.ok(provider.includes('ensureTrustedForMutation();'));
  assert.equal(
    parseWebviewMessage({ type: 'requestSend', command: 'prompt' })?.type,
    'requestSend'
  );
  assert.equal(parseWebviewMessage({ type: 'requestSend', command: 'evil' }), undefined);
});

test('reviewer repro 5: RPC timeout clears pending slot and ignores late response', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 1,
    maxQueuedWrites: 8,
  });
  const client = new RpcClient(1, transport, { shortTimeoutMs: 20, longTimeoutMs: 20 });
  await assert.rejects(client.getState(), /Timed out waiting for get_state/);
  const next = client.getState();
  stdout.write(
    '{"id":"g1-r1","type":"response","command":"get_state","success":true,"data":{"sessionId":"late"}}\n'
  );
  stdout.write(
    '{"id":"g1-r2","type":"response","command":"get_state","success":true,"data":{"sessionId":"ok"}}\n'
  );
  const result = await next;
  assert.equal(result?.sessionId, 'ok');
});

test('reviewer repro 6: diagnostics export is redacted and allowlisted', () => {
  const logger = {
    health(extra: Record<string, unknown>) {
      return { recentLogLines: ['token=[REDACTED]'], ...extra };
    },
  } as any;
  const controller = {
    folder: { uri: { fsPath: '/Users/demo/project' }, name: 'project' },
    snapshot: {
      connectionState: 'ready',
      generation: 1,
      queue: { steering: ['one'], followUp: ['two'] },
      state: {
        model: { provider: 'mock', id: 'model' },
        thinkingLevel: 'medium',
        sessionFile: '/Users/demo/project/session.jsonl',
        sessionId: 'id',
        sessionName: 'name',
        messageCount: 1,
        pendingMessageCount: 0,
        autoCompactionEnabled: true,
      },
      lastEventType: 'agent_settled',
      eventHistory: [
        { type: 'agent_settled', timestamp: 1, id: 'e', data: { type: 'agent_settled' } },
      ],
      uiHistory: [
        {
          id: 'u',
          method: 'notify',
          timestamp: 1,
          data: { type: 'extension_ui_request', id: 'u', method: 'notify', message: 'ok' },
        },
      ],
      diagnostics: [
        { id: 'd', kind: 'info', message: 'draft secret', detail: 'stderr secret', timestamp: 1 },
      ],
      lastSessionStats: { cost: 1 },
      restartCount: 0,
    },
  } as any;
  const exported = createRedactedDiagnosticsExport(logger, controller);
  const text = JSON.stringify(exported);
  assert.ok(!text.includes('draft'));
  assert.ok(!text.includes('stderr secret'));
  assert.ok(!text.includes('/Users/demo'));
  assert.ok(text.includes('[HOME]'));
});

test('reviewer repro 7: session path validation is canonical', async () => {
  const canonical = await canonicalizeSessionPath(process.cwd(), './package.json');
  assert.ok(canonical.endsWith('/package.json'));
});

test('reviewer repro 8: installed rpc wire shapes match parser assumptions', () => {
  const installed = readFileSync(
    '/Users/narender/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts',
    'utf8'
  );
  assert.ok(installed.includes('type: "new_session"'));
  assert.ok(installed.includes('parentSession?: string'));
  assert.ok(installed.includes('customInstructions?: string'));
  assert.ok(installed.includes('statusKey: string'));
  assert.ok(installed.includes('widgetKey: string'));
});

test('reviewer repro 9: extension UI reducer keeps keyed statuses, widgets, title, and cancel distinctions', () => {
  let state = createInitialControllerState('workspace', '/tmp/workspace');
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: '1',
    method: 'setStatus',
    statusKey: 'k',
    statusText: 'v',
  });
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: '2',
    method: 'setWidget',
    widgetKey: 'w',
    widgetLines: ['line'],
    widgetPlacement: 'belowEditor',
  });
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: '3',
    method: 'setTitle',
    title: 'hello',
  });
  state = reduceExtensionUiRequest(state, {
    type: 'extension_ui_request',
    id: '4',
    method: 'confirm',
    title: 'confirm',
    message: 'go',
    timeout: 1,
  });
  assert.equal(state.statuses.k, 'v');
  assert.equal(state.widgets[0]?.placement, 'belowEditor');
  assert.equal(state.title, 'hello');
  assert.equal(state.pendingUi[0]?.method, 'confirm');
});

test('reviewer repro 10: webview message validation rejects malformed command traffic', () => {
  assert.equal(
    parseWebviewMessage({ type: 'switchFolder', folderUri: 'file:///tmp' })?.type,
    'switchFolder'
  );
  assert.equal(
    parseWebviewMessage({ type: 'openAttachment', uri: 'file:///tmp/workspace/file.txt' })?.type,
    'openAttachment'
  );
  assert.equal(parseWebviewMessage({ type: 'switchFolder' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'openAttachment' }), undefined);
  assert.equal(parseWebviewMessage({ type: 'executeCommand', command: 1 }), undefined);
});

test('reviewer repro 11: exact unknown-event repro degrades without disconnect', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 2,
    maxQueuedWrites: 8,
  });
  let protocolFault: string | undefined;
  let disconnected: string | undefined;
  transport.on('protocolFault', (error) => {
    protocolFault = error.message;
  });
  transport.on('disconnected', (error) => {
    disconnected = error.message;
  });
  stdout.write('{"type":"new_unknown_event","payload":"token=abc"}\n');
  const request = transport.request({ id: '1', type: 'get_state' });
  stdout.write('{"id":"1","type":"response","command":"get_state","success":true,"data":{}}\n');
  const response = await request;
  assert.equal(response.success, true);
  assert.equal(protocolFault, undefined);
  assert.equal(disconnected, undefined);
});

test('reviewer repro 12: malformed correlated response still disconnects', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new RpcTransport(stdin, stdout, null, {
    maxRecordBytes: 1024,
    maxBufferBytes: 1024,
    maxPendingRequests: 1,
    maxQueuedWrites: 8,
  });
  let disconnected: string | undefined;
  transport.on('disconnected', (error) => {
    disconnected = error.message;
  });
  const pending = transport.request({ id: '1', type: 'get_state' });
  stdout.write('{"id":"1","type":"new_unknown_event","command":"get_state"}\n');
  await assert.rejects(pending, /Unexpected compatibility envelope for pending id: 1/);
  assert.equal(disconnected, 'Unexpected compatibility envelope for pending id: 1');
});

test('reviewer repro 13: multi-root selection surface is explicit in tree and extension', () => {
  const extension = readFileSync('src/extension.ts', 'utf8');
  const tree = readFileSync('src/ui/trees/sessionSidebarModel.ts', 'utf8');
  assert.ok(extension.includes('piRpcInternal.selectWorkspaceFolder'));
  assert.ok(tree.includes('piRpcInternal.selectWorkspaceFolder'));
});

function webviewSnapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    uiMode: 'simple',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 0,
    pendingMessageCount: 0,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: 'draft',
    statuses: {},
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...overrides,
  };
}

test('reviewer repro 14: preview dialog and chip focus affordances are wired accessibly', () => {
  const snapshot = webviewSnapshot({
    focus: 'imageChip',
    pendingContextItems: [
      {
        kind: 'selection',
        itemId: 'ctx-1',
        workspaceFolder: '/tmp/workspace',
        workspaceRelativePath: 'src/app.ts',
        lineStart: 2,
        lineEnd: 4,
        languageId: 'typescript',
        sanitizedContent: 'const value = 1;',
        capturedAt: '2024-01-01T00:00:00.000Z',
        persistedRef: {
          workspaceRelativePath: 'src/app.ts',
          lineStart: 2,
          lineEnd: 4,
          languageId: 'typescript',
          contentFingerprint: 'abc',
        },
      },
    ],
    pendingImages: [
      {
        itemId: 'img-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        sizeBytes: 42,
      },
    ],
    preview: {
      command: 'prompt',
      draft: 'hello',
      rpcMessage: 'hello',
      rpcImages: [],
      imageItems: [],
    },
  });
  const html = renderChatApp(snapshot);
  const chatSource = readFileSync('src/webview/media/chat.ts', 'utf8');

  assert.equal(focusTargetFromSnapshot(snapshot), PREVIEW_ACCEPT_BUTTON_ID);
  assert.deepEqual(planChipRemovalFocus(snapshot, 'ctx-1'), {
    targetId: imageChipRemoveButtonId('img-1'),
    fallbackId: ATTACH_TRIGGER_ID,
  });
  assert.match(html, new RegExp(`id="${PREVIEW_ACCEPT_BUTTON_ID}"`));
  assert.match(html, new RegExp(`aria-describedby="${PREVIEW_DESCRIPTION_ID}"`));
  assert.match(html, new RegExp(`id="${contextChipRemoveButtonId('ctx-1')}"`));
  assert.match(html, new RegExp(`id="${imageChipRemoveButtonId('img-1')}"`));
  assert.match(chatSource, /event\.key === 'Escape'/);
  assert.match(chatSource, /nextPreviewTrapTarget/);
  assert.match(chatSource, /focus: 'none'/);
});

test('reviewer repro 15: malformed session timestamps never surface NaNd ago', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rpc-reviewer-14-'));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  try {
    const sessionDir = getDefaultSessionDirForWorkspace(workspace, agentDir);
    const fallbackTime = new Date('2024-01-03T00:00:00.000Z');
    const sessionPath = join(sessionDir, 'bad.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: 'session',
          id: 'bad',
          timestamp: 'not-a-time',
          cwd: workspace,
        }),
        JSON.stringify({ type: 'session_info', name: 'Broken ts' }),
      ].join('\n') + '\n',
      'utf8'
    );
    await utimes(sessionPath, fallbackTime, fallbackTime);

    const index = await readRecentSessionsIndex({
      workspaceName: 'workspace',
      workspacePath: workspace,
    });
    const model = createResumeChatSidebarModel({
      activeFolderName: 'workspace',
      recent: {
        loading: false,
        filterText: '',
        items: index.sessions,
        sessionDir,
      },
      hasDraft: false,
      hasPendingAttachments: false,
      now: Date.UTC(2024, 0, 4, 0, 0, 0),
    });
    const recentNode = model[2];

    assert.equal(index.sessions[0]?.createdAt, fallbackTime.getTime());
    assert.equal(index.sessions[0]?.modifiedAt, fallbackTime.getTime());
    assert.equal(recentNode?.description, 'workspace · 1d ago');
    assert.ok(!recentNode?.description?.includes('NaN'));
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});
