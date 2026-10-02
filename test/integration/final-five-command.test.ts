import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createEmptyComposerState } from '../../src/webview/composer';

async function compiled(cancel = false) {
  const output = await build({
    stdin: { contents: "export * from './src/commands/localCommand';", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const module = { exports: {} as any };
  const require = createRequire(`${process.cwd()}/package.json`);
  new Function('require', 'module', 'exports', output.outputFiles[0]!.text)(
    (id: string) =>
      id === 'vscode'
        ? {
            window: {
              showQuickPick: async (items: any[]) => (cancel ? undefined : items[0]),
              showWarningMessage: async (_text: string, _options: any, action: string) =>
                cancel ? undefined : action,
              showInputBox: async () => (cancel ? undefined : 'owned-dummy-key'),
              showInformationMessage: async () => undefined,
              withProgress: async (_options: any, callback: any) =>
                callback(
                  {},
                  {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose: () => {} }),
                  }
                ),
            },
            ProgressLocation: { Notification: 1 },
            workspace: { isTrusted: true },
            authentication: { getSession: async () => ({ accessToken: 'owned-dummy-token' }) },
          }
        : require(id),
    module,
    module.exports
  );
  return module.exports;
}
for (const name of ['logout', 'login', 'share', 'bug', 'import']) {
  test(`compiled /${name} confirmed local operation ACKs without clearing images`, async () => {
    const { handleLocalCommand } = await compiled();
    const state = createEmptyComposerState();
    state.pendingImages = [
      { itemId: 'owned-image', name: 'owned', mimeType: 'image/png', sizeBytes: 1 },
    ];
    state.draft = name === 'import' ? '/import owned.jsonl ignored' : `/${name}`;
    let calls = 0;
    const controller = {
      captureLifecycleIntent: () => ({
        valid: () => true,
        prepareImport: async () => ({ nonce: 'owned', cwd: '/owned', version: 3, entries: 1 }),
        run: async () => {
          calls++;
          return { cancelled: false, valid: () => true, replacementIdentity: { sessionId: 'new' } };
        },
      }),
      folder: { uri: { scheme: 'file', fsPath: '/owned' } },
      captureDeliveryIntent: () => ({
        valid: () => true,
        payload: async () => {
          calls++;
          return { jsonl: '{"type":"session"}\n' };
        },
      }),
      snapshot: { state: { sessionId: 'owned' } },
      captureAuthIntent: () => ({
        valid: () => true,
        providers: async () => [
          { providerId: 'owned', name: 'Owned', stored: true, types: ['api_key'] },
        ],
        run: async () => {
          calls++;
          return true;
        },
      }),
    };
    const delivered: Array<{ url: string; body: unknown }> = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, options: RequestInit) => {
      delivered.push({ url, body: options.body });
      return new Response(
        JSON.stringify({
          html_url: 'https://gist.github.com/owned/123abc',
          ok: true,
          bug_report: { id: 'owned-report' },
        }),
        { status: 201 }
      );
    }) as typeof fetch;
    await handleLocalCommand(
      controller,
      state,
      async () => state,
      async (next: any) => Object.assign(state, next),
      async () => {},
      'owned',
      () => true,
      {
        valid: () => true,
        replace: async () => {},
        close: async () => {},
        resume: async () => undefined,
      }
    );
    globalThis.fetch = previousFetch;
    if (name === 'share') {
      assert.equal(delivered[0]?.url, 'https://api.github.com/gists');
      const body = JSON.parse(String(delivered[0]?.body));
      assert.equal(body.public, false);
      assert.equal(body.files['session.jsonl'].content, '{"type":"session"}\n');
    }
    if (name === 'bug') {
      assert.equal(delivered[0]?.url, 'https://radius.pi.dev/v1/bug-reports');
      const body = delivered[0]?.body as FormData;
      assert.equal(await (body.get('session.jsonl') as Blob).text(), '{"type":"session"}\n');
      assert.ok(body.get('report.json'));
      assert.ok(body.get('diagnostics.json'));
    }
    assert.equal(calls, 1);
    assert.equal(state.localCommandAck, 'owned');
    assert.equal(state.draft, '');
    assert.equal(state.pendingImages[0]?.itemId, 'owned-image');
  });
  test(`compiled /${name} cancellation retains draft/chips with no auth/upload/ACK`, async () => {
    const { handleLocalCommand } = await compiled(true);
    const state = createEmptyComposerState();
    state.draft = name === 'import' ? '/import owned.jsonl' : `/${name}`;
    state.pendingImages = [{ itemId: 'owned', name: 'owned', mimeType: 'image/png', sizeBytes: 1 }];
    const initial = state.draft;
    let mutations = 0;
    const forbidden = async () => {
      mutations++;
      throw new Error('Unconsented mutation');
    };
    const controller = {
      folder: { uri: { scheme: 'file', fsPath: '/owned' } },
      snapshot: { state: { sessionId: 'owned' } },
      captureDeliveryIntent: () => ({
        valid: () => true,
        payload: async () => ({ jsonl: 'owned' }),
      }),
      captureAuthIntent: () => ({
        valid: () => true,
        providers: async () => [{ providerId: 'owned', stored: true, types: ['api_key'] }],
        run: forbidden,
      }),
      captureLifecycleIntent: () => ({
        valid: () => true,
        prepareImport: async () => ({ nonce: 'owned', version: 3, entries: 1 }),
        run: forbidden,
      }),
    };
    await handleLocalCommand(
      controller,
      state,
      async () => state,
      async (next: any) => Object.assign(state, next),
      async () => {},
      'owned',
      () => true,
      { valid: () => true, replace: forbidden, close: forbidden, resume: async () => undefined }
    );
    assert.equal(mutations, 0);
    assert.equal(state.draft, name === 'import' ? initial : '');
    assert.equal(state.localCommandConsumed, name === 'import' ? undefined : 'owned');
    assert.equal(state.localCommandAck, undefined);
    assert.equal(state.pendingImages[0]?.itemId, 'owned');
  });
}
