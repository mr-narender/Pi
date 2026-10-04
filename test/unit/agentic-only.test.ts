import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import packageJson from '../../package.json';

const source = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');

test('Agentic has no legacy panel, sessions sidebar or interface rollback contributions', () => {
  for (const file of [
    'src/webview/provider.ts',
    'src/ui/sidebar/sessionsWebview.ts',
    'src/ui/sidebar/state.ts',
  ]) {
    assert.equal(existsSync(join(process.cwd(), file)), false, file);
  }
  const manifest = JSON.stringify(packageJson.contributes);
  for (const id of [
    'piRpc.editorTabs.enabled',
    'piRpc.sidebarMode',
    'piRpc.toggleSidebarMode',
    'piRpc.sessions',
  ]) {
    assert.equal(manifest.includes(id), false, id);
  }
  const extension = source('src/extension.ts');
  assert.equal(
    /ChatPanelProvider|SessionsWebviewProvider|editorTabsEnabled/.test(extension),
    false
  );
});

test('Agentic native chat identity rejects obsolete path and query aliases', () => {
  const uri = source('src/editorTabs/uri.ts');
  assert.equal(/parseChatPath|parseChatQuery/.test(uri), false);
  assert.match(uri, /return lookupChatUri\(uri.path\)/);
});

test('Agentic exposes full chat and return-to-list surfaces without an interface selector', () => {
  const ids: string[] = packageJson.contributes.commands.map((entry) => entry.command);
  assert.ok(ids.includes('piRpcInternal.switchToFullChat'));
  assert.ok(ids.includes('piRpcInternal.showChatList'));
  const extension = source('src/extension.ts');
  assert.match(extension, /sidebarSurface/);
  assert.equal(extension.includes("get<'agentic' | 'chat'>('sidebarMode'"), false);
});
