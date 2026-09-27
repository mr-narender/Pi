import test from 'node:test';
import assert from 'node:assert/strict';
import packageJson from '../../package.json';
import { readFileSync } from 'node:fs';

const coverage = readFileSync('docs/RPC_COVERAGE.md', 'utf8');
const actionIds = [...coverage.matchAll(/`(piRpc\.[^`]+)`/g)].map((match) => match[1]);

test('coverage matrix action ids are unique and fully contributed', () => {
  const unique = new Set(actionIds);
  assert.equal(actionIds.length, unique.size);
  assert.equal(unique.size, 82);
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
  assert.equal((coverage.match(/\| X-\d+/g) ?? []).length, 19);
  assert.equal((coverage.match(/\| D-\d+/g) ?? []).length, 8);
});

test('manifest contributes the Open/Recent Chats tree views + the Chat webview', () => {
  const view = packageJson.contributes.views.piRpc;
  assert.deepEqual(
    view.map((entry) => entry.id),
    ['piRpc.openSessions', 'piRpc.recentSessions', 'piRpc.chat']
  );
  const chatWebview = view.find((entry) => entry.id === 'piRpc.chat');
  assert.equal(chatWebview?.type, 'webview');
  // The two tree views are native TreeDataProviders (Agentic Mode's "Open
  // Chat List") — no `type` field, VS Code's manifest schema treats that
  // as a tree view implicitly.
  const openSessions = view.find((entry) => entry.id === 'piRpc.openSessions');
  const recentSessions = view.find((entry) => entry.id === 'piRpc.recentSessions');
  assert.equal(openSessions?.type, undefined);
  assert.equal(recentSessions?.type, undefined);
  const allMenus = JSON.stringify(packageJson.contributes.menus ?? {});
  assert.ok(!allMenus.includes('piRpc.currentChat'));
});

test('manifest exposes delete and rename chat commands for the sidebar', () => {
  const commands = packageJson.contributes.commands.map((item) => item.command);
  assert.ok(commands.includes('piRpcInternal.deleteSession'));
  assert.ok(commands.includes('piRpcInternal.renameSession'));
});
