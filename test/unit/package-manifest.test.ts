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

test('manifest contributes a single Chats launcher sidebar view', () => {
  assert.deepEqual(
    packageJson.contributes.views.piRpc.map((view) => view.id),
    ['piRpc.sessions']
  );
  const allMenus = JSON.stringify(packageJson.contributes.menus ?? {});
  assert.ok(!allMenus.includes('piRpc.currentChat'));
});

test('manifest exposes an inline trash action to delete a chat session', () => {
  const command = packageJson.contributes.commands.find(
    (item) => item.command === 'piRpcInternal.deleteSession'
  );
  assert.ok(command, 'missing piRpcInternal.deleteSession command');
  assert.equal(command.icon, '$(trash)');
  const itemMenus = packageJson.contributes.menus['view/item/context'] ?? [];
  const inline = itemMenus.find((item) => item.command === 'piRpcInternal.deleteSession');
  assert.ok(inline, 'missing inline delete menu');
  assert.equal(inline.group, 'inline');
  assert.match(String(inline.when), /piRpc\.recentSession/);
});
