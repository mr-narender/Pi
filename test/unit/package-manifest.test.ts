import test from 'node:test';
import assert from 'node:assert/strict';
import packageJson from '../../package.json';
import { readFileSync } from 'node:fs';

const coverage = readFileSync('docs/RPC_COVERAGE.md', 'utf8');
const actionIds = [...coverage.matchAll(/`(piRpc\.[^`]+)`/g)].map((match) => match[1]);

test('coverage matrix action ids are unique and fully contributed', () => {
  const unique = new Set(actionIds);
  assert.equal(actionIds.length, unique.size);
  assert.equal(unique.size, 31);
  const contributed = new Set(packageJson.contributes.commands.map((command) => command.command));
  for (const id of unique) {
    assert.ok(typeof id === 'string');
    assert.ok(contributed.has(id), `missing command contribution for ${id}`);
  }
});

test('coverage row inventory totals stay stable', () => {
  assert.equal((coverage.match(/\| C-\d+/g) ?? []).length, 34);
  assert.equal((coverage.match(/\| E-\d+/g) ?? []).length, 20);
  assert.equal((coverage.match(/\| U-\d+/g) ?? []).length, 9);
  assert.equal((coverage.match(/\| X-\d+/g) ?? []).length, 0);
  assert.equal((coverage.match(/\| D-\d+/g) ?? []).length, 8);
});

test('manifest contributes exactly one always-visible Chat webview; mode is content, not view visibility', () => {
  // Superseded the native-tree-view "Open Chat List" attempt entirely — a
  // native TreeDataProvider has no extension-facing API for row spacing,
  // font size, or custom (non-Codicon) icons/buttons, confirmed against
  // VS Code's own source (listView.ts row-height options are internal,
  // never exposed to extensions) and the VS Code team's own admission that
  // list/tree isn't a good fit for chat UI (microsoft/vscode#268858). One
  // Agentic owns both surfaces without a second contributed view.
  const view = packageJson.contributes.views.piRpc;
  assert.deepEqual(
    view.map((entry) => entry.id),
    ['piRpc.chat']
  );
  const chatWebview = view[0];
  assert.equal(chatWebview?.type, 'webview');
  assert.ok(!('when' in chatWebview));
  const allMenus = JSON.stringify(packageJson.contributes.menus ?? {});
  assert.ok(!allMenus.includes('piRpc.currentChat'));
  assert.ok(!allMenus.includes('piRpc.openChatList'));
});

test('manifest exposes delete and rename chat commands for the sidebar', () => {
  const commands = packageJson.contributes.commands.map((item) => item.command);
  assert.ok(commands.includes('piRpcInternal.deleteSession'));
  assert.ok(commands.includes('piRpcInternal.renameSession'));
});
