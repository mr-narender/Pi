// #4 (review round 2): the webview→extension command allowlist must never
// drift from what the renderer actually emits. This test scrapes both sides
// from source, so adding a data-command without updating the allowlist FAILS
// the gate instead of silently dead-ending the button (or worse, someone
// widening the executeCommand path again).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function commandsEmittedByWebview(): Set<string> {
  const sources = [
    readFileSync(join(root, 'src/webview/render.ts'), 'utf8'),
    readFileSync(join(root, 'src/webview/media/chat.ts'), 'utf8'),
  ].join('\n');
  const found = new Set<string>();
  for (const match of sources.matchAll(/data-command="([a-zA-Z.]+)"/g)) {
    found.add(match[1]!);
  }
  for (const match of sources.matchAll(/type: 'executeCommand', command: '([a-zA-Z.]+)'/g)) {
    found.add(match[1]!);
  }
  return found;
}

function allowlisted(): Set<string> {
  const source = readFileSync(join(root, 'src/editorTabs/tabManager.ts'), 'utf8');
  const block = /WEBVIEW_COMMAND_ALLOWLIST = new Set<string>\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(block, 'allowlist block not found in tabManager.ts');
  const entries = new Set<string>();
  for (const match of block![1]!.matchAll(/'([a-zA-Z.]+)'/g)) {
    entries.add(match[1]!);
  }
  return entries;
}

test('every command the webview emits is allowlisted', () => {
  const emitted = commandsEmittedByWebview();
  const allowed = allowlisted();
  const missing = [...emitted].filter((command) => !allowed.has(command));
  assert.deepEqual(
    missing,
    [],
    `webview emits non-allowlisted commands: ${missing.join(', ')} — add them to WEBVIEW_COMMAND_ALLOWLIST (tabManager.ts) deliberately`
  );
});

test('the allowlist carries no stale entries', () => {
  const emitted = commandsEmittedByWebview();
  const allowed = allowlisted();
  const stale = [...allowed].filter((command) => !emitted.has(command));
  assert.deepEqual(
    stale,
    [],
    `allowlist entries no longer emitted by the webview: ${stale.join(', ')} — remove them`
  );
});
