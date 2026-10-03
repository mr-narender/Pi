// #7 (hardening review): GOLDEN-HTML contract tests. The chat renderer is a
// string-template engine — regex assertions only guard fragments, so visual
// contract breaks (like the box-in-box tables or the split tool cards) slipped
// through. These tests pin the FULL HTML for canonical snapshots.
//
// Update intentionally with:  UPDATE_GOLDEN=1 npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderChatApp } from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

// Tests run from the repo root (npm scripts) — keep CJS-config compatible.
const goldenDir = join(process.cwd(), 'test', 'unit', '__golden__');

function base(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    bindingState: 'current',
    uiMode: 'simple',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 2,
    pendingMessageCount: 0,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: '',
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

function checkGolden(name: string, html: string): void {
  const file = join(goldenDir, `${name}.html`);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, html, 'utf8');
    return;
  }
  const expected = readFileSync(file, 'utf8');
  assert.equal(
    html,
    expected,
    `golden mismatch for ${name} — review the diff; if intentional run UPDATE_GOLDEN=1 npm run test:unit`
  );
}

test('golden: fused tool call+result turn', () => {
  const html = renderChatApp(
    base({
      messages: [
        { id: 'u1', role: 'user', text: 'run ls', attachments: [] },
        {
          id: 'a1',
          role: 'assistant',
          text: '',
          attachments: [],
          blocks: [
            { kind: 'thinking', text: 'checking the directory' },
            { kind: 'tool', name: 'bash', args: '{"cmd":"ls"}', callId: 'c1' },
            { kind: 'toolResult', name: 'bash', text: 'file.txt\nnotes.md', callId: 'c1' },
            { kind: 'text', text: 'Two files: `file.txt` and `notes.md`.' },
          ],
        },
      ],
    })
  );
  checkGolden('tool-pair-turn', html);
});

test('golden: failed turn with provider error + retry banner', () => {
  const html = renderChatApp(
    base({
      retry: { attempt: 2, errorMessage: 'upstream 429: rate limit exceeded' },
      messages: [
        { id: 'u1', role: 'user', text: 'hello', attachments: [] },
        {
          id: 'a1',
          role: 'assistant',
          text: '',
          attachments: [],
          errorMessage: 'upstream 429: rate limit exceeded',
        },
      ],
    })
  );
  checkGolden('error-turn', html);
});

test('golden: draft connecting loader', () => {
  const html = renderChatApp(
    base({
      connectionState: 'starting',
      sessionFile: undefined,
      sessionName: undefined,
      bindingState: 'draft',
      messages: [],
    })
  );
  checkGolden('connecting-loader', html);
});

test('golden: faulted empty state', () => {
  const html = renderChatApp(base({ connectionState: 'faulted', messages: [] }));
  checkGolden('faulted-empty', html);
});

test('golden: long tool result stays collapsed with line count', () => {
  const longText = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
  const html = renderChatApp(
    base({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          text: '',
          attachments: [],
          blocks: [
            { kind: 'tool', name: 'bash', args: '{"cmd":"find ."}', callId: 'c1' },
            { kind: 'toolResult', name: 'bash', text: longText, callId: 'c1' },
            { kind: 'text', text: 'Done.' },
          ],
        },
      ],
    })
  );
  checkGolden('long-result-clamp', html);
});

test('golden: queue tray with steering entries', () => {
  const html = renderChatApp(
    base({
      isStreaming: true,
      connectionState: 'busy',
      queue: { steering: ['also check the tests', 'and update docs'], followUp: [] },
      messages: [{ id: 'u1', role: 'user', text: 'refactor this', attachments: [] }],
    })
  );
  checkGolden('queue-tray', html);
});
