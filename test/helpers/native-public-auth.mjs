// Fixed owned public-registry callback smoke; no caller-supplied module/provider/factory.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createAuthCommands } from './auth-commands.mjs';
const { ModelRuntime } = await import(
  pathToFileURL(join(process.env.PI_HOST_PI_ROOT, 'dist/index.js')).href
);
const authPath = join(process.env.PI_CODING_AGENT_DIR, 'owned-public-auth.json');
const runtime = await ModelRuntime.create({
  authPath,
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
let cancelled = false;
const auth = {
  name: 'Owned OAuth',
  async login(interaction) {
    interaction.notify({
      type: 'device_code',
      userCode: 'OWNED',
      verificationUri: 'https://owned.invalid/device',
    });
    const selected = await interaction.prompt({
      type: 'select',
      message: 'Owned selection',
      options: [{ id: 'owned', label: 'Owned' }],
    });
    if (selected !== 'owned') throw new Error('Owned selection mismatch');
    const value = await interaction.prompt({ type: 'secret', message: 'Owned private code' });
    if (value !== 'owned-dummy-code') throw new Error('Owned code mismatch');
    interaction.signal.throwIfAborted();
    return {
      type: 'oauth',
      access: 'owned-dummy-access',
      refresh: 'owned-dummy-refresh',
      expires: Date.now() + 3600000,
    };
  },
  async refresh() {
    throw new Error('No OAuth refresh permitted in this smoke');
  },
  async toAuth(c) {
    return { apiKey: c.access };
  },
};
runtime.registerNativeProvider({
  id: 'owned-public-oauth',
  name: 'Owned',
  auth: { oauth: auth },
  getModels: () => [],
  stream() {
    throw new Error('No providers permitted');
  },
  streamSimple() {
    throw new Error('No providers permitted');
  },
});
const commands = createAuthCommands(() => ({ modelRuntime: runtime }));
const start = commands.start('owned-public-oauth', 'oauth');
for (let i = 0; i < 200; i++) {
  const step = commands.poll(start.nonce);
  if (step.status !== 'pending') {
    if (step.status !== 'applied') throw new Error('Owned OAuth failed');
    break;
  }
  if (step.prompt)
    commands.respond(
      start.nonce,
      step.prompt.nonce,
      step.prompt.type === 'select' ? 'owned' : 'owned-dummy-code'
    );
  await new Promise((r) => setTimeout(r, 5));
}
const saved = JSON.parse(await readFile(authPath, 'utf8'));
if (saved['owned-public-oauth']?.access !== 'owned-dummy-access')
  throw new Error('Owned store failed');
await commands.logout('owned-public-oauth');
if (JSON.parse(await readFile(authPath, 'utf8'))['owned-public-oauth'])
  throw new Error('Owned removal failed');
const cancel = commands.start('owned-public-oauth', 'oauth');
commands.respond(cancel.nonce, undefined, null);
for (let i = 0; i < 200; i++) {
  if (commands.poll(cancel.nonce).status === 'cancelled') {
    cancelled = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 5));
}
commands.dispose();
if (!cancelled) throw new Error('Owned cancel failed');
process.stdout.write(
  JSON.stringify({ oauthStore: true, logout: true, cancel: true, secretWire: false }) + '\n'
);
// Fixed callback barrier: native completion is independent of the manual prompt.
let releaseCallback;
let callbackSignal;
let callbackNonce;
const raceCommands = createAuthCommands(() => ({ modelRuntime: runtime }));
runtime.registerNativeProvider({
  id: 'owned-callback-oauth',
  name: 'Owned callback',
  auth: {
    oauth: {
      name: 'Owned callback',
      async login(interaction) {
        callbackSignal = interaction.signal;
        void interaction
          .prompt({ type: 'secret', message: 'Owned held manual input' })
          .catch(() => {});
        await new Promise((resolve) => {
          releaseCallback = resolve;
        });
        // Deliberately ignore abort here: public ModelRuntime must guard the store.
        return {
          type: 'oauth',
          access: 'PRIVATE_OWNED_CALLBACK_CANARY',
          refresh: 'owned-refresh',
          expires: Date.now() + 3600000,
        };
      },
      async refresh() {
        throw new Error('No refresh allowed');
      },
      async toAuth(c) {
        return { apiKey: c.access };
      },
    },
  },
  getModels: () => [],
  stream() {
    throw new Error('No providers permitted');
  },
  streamSimple() {
    throw new Error('No providers permitted');
  },
});
if (process.argv.includes('--owned-callback-barrier')) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    let data;
    switch (request.type) {
      case 'auth_providers':
        data = {
          providers: raceCommands
            .providers()
            .filter((p) => p.providerId === 'owned-callback-oauth'),
        };
        break;
      case 'auth_login':
        data = raceCommands.start('owned-callback-oauth', 'oauth');
        callbackNonce = data.nonce;
        break;
      case 'cancel_native':
        data = raceCommands.respond(callbackNonce, undefined, null);
        break;
      case 'auth_poll':
        data = raceCommands.poll(request.payload.nonce);
        break;
      case 'auth_response':
        try {
          data = raceCommands.respond(
            request.payload.nonce,
            request.payload.promptNonce,
            request.payload.value
          );
        } catch {
          data = { stale: true };
        }
        break;
      case 'release':
        releaseCallback();
        data = {};
        break;
      case 'inspect': {
        const stored = JSON.parse(await readFile(authPath, 'utf8'));
        data = {
          aborted: callbackSignal?.aborted,
          stored: !!stored['owned-callback-oauth'],
          canary: stored['owned-callback-oauth']?.access === 'PRIVATE_OWNED_CALLBACK_CANARY',
        };
        break;
      }
      default:
        throw new Error('Unowned fixed auth action');
    }
    process.stdout.write(JSON.stringify({ id: request.id, data }) + '\n');
  }
  raceCommands.dispose();
}
