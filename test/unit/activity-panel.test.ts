import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { createInitialControllerState } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { renderActivityContent, renderActivityPanel } from '../../src/webview/render';

function fixture() {
  const state = createInitialControllerState('work', '/tmp/work');
  const snapshot = () =>
    createWebviewSnapshot(state, 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    });
  return { state, snapshot };
}

test('activity projects real partial/completed/error tool output and native duration', () => {
  const { state, snapshot } = fixture();
  state.tools = [
    {
      id: 'one',
      name: 'bash',
      startedAt: 1,
      partialResult: { content: [{ type: 'text', text: 'line one\nline two' }] },
    },
  ];
  assert.equal(snapshot().activity?.tools[0]?.status, 'running');
  assert.equal(snapshot().activity?.output, 'line one\nline two');
  Object.assign(state.tools[0]!, {
    endedAt: 2,
    durationMs: 9,
    result: { content: [{ type: 'text', text: 'done' }] },
  });
  assert.equal(snapshot().activity?.tools[0]?.status, 'completed');
  assert.equal(snapshot().activity?.tools[0]?.durationMs, 9);
  assert.equal(snapshot().activity?.output, 'done');
  state.tools[0]!.isError = true;
  assert.equal(snapshot().activity?.tools[0]?.status, 'error');
});

test('activity bounds output and metadata without shipping images, base64, or raw details', () => {
  const { state, snapshot } = fixture();
  state.tools = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    name: 'bash',
    startedAt: i,
    partialResult: {
      content: [
        { type: 'image', data: 'IMAGE_PRIVATE' },
        { type: 'text', text: 'x'.repeat(10000) },
      ],
      details: { private: 'DETAIL_PRIVATE' },
    },
  }));
  const activity = snapshot().activity!;
  assert.ok(activity.tools.length <= 8);
  assert.ok(activity.output.length <= 4001);
  assert.ok(JSON.stringify(activity).length < 10000);
  assert.doesNotMatch(JSON.stringify(activity), /IMAGE_PRIVATE|DETAIL_PRIVATE|partialResult/);
  state.tools[99]!.partialResult = {
    content: [{ type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(8000) }],
  };
  assert.doesNotMatch(snapshot().activity!.output, /AAAA/);
});

test('activity files are deduplicated workspace paths and do not offer escaped or URL paths', () => {
  const { state, snapshot } = fixture();
  state.tools = ['src/a.ts', './src/a.ts', '../outside.ts', 'https://example.com'].map(
    (path, i) => ({ id: String(i), name: 'read', args: { path }, startedAt: i })
  );
  assert.deepEqual(snapshot().activity?.files, [{ path: 'src/a.ts' }]);
});

test('Windows activity files normalize separators and exclude paths outside the workspace', () => {
  const compiled = buildSync({
    entryPoints: ['src/webview/activity.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const loaded = { exports: {} as typeof import('../../src/webview/activity') };
  const nativeRequire = createRequire(`${process.cwd()}/package.json`);
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (name: string) => (name === 'node:path' ? win32 : nativeRequire(name)),
    loaded,
    loaded.exports
  );
  const state = createInitialControllerState('work', 'C:\\work');
  state.tools = [
    'C:\\work\\src\\a.ts',
    'src\\a.ts',
    '..\\outside.ts',
    'D:\\other.ts',
    'https://example.com',
  ].map((path, index) => ({ id: String(index), name: 'read', args: { path }, startedAt: index }));
  assert.deepEqual(loaded.exports.projectActivity(state, []).files, [{ path: 'src/a.ts' }]);
  state.tools = state.tools.slice(0, 1);
  assert.deepEqual(loaded.exports.projectActivity(state, []).files, [{ path: 'src/a.ts' }]);
});

test('activity redacts text before truncation and bounds status/widget metadata', () => {
  const { state, snapshot } = fixture();
  state.tools = [
    {
      id: 'one',
      name: 'bash',
      startedAt: 1,
      partialResult: {
        content: [{ type: 'text', text: `${'ok '.repeat(1330)}sk-abcdefghijklmno\nnext` }],
      },
    },
  ];
  state.statuses = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [String(index), 'status '.repeat(300)])
  );
  state.widgets = [{ key: 'extra', lines: ['widget '.repeat(1000)], placement: 'aboveEditor' }];
  const activity = snapshot().activity!;
  assert.doesNotMatch(activity.output, /sk-/);
  assert.equal(activity.statuses.length, 8);
  assert.ok(activity.statuses.every((status) => status.text.length <= 241));
  state.statuses = {};
  assert.equal(snapshot().activity?.statuses[0]?.label, 'extra');
});

test('activity renders escaped output, truthful empty agents and selected accessible tabs', () => {
  const { state, snapshot } = fixture();
  state.tools = [
    {
      id: 'one',
      name: '<script>bad</script>',
      startedAt: 1,
      partialResult: { content: [{ type: 'text', text: '<img src=x onerror=bad>\nline' }] },
    },
  ];
  const html = renderActivityPanel(snapshot());
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('img,script'), null);
  assert.match(dom.window.document.querySelector('.activity-output')!.textContent!, /<img/);
  assert.match(
    renderActivityContent(snapshot(), 'agents'),
    /No subagent details have been reported/
  );
  const selected = new JSDOM(renderActivityContent(snapshot(), 'sources')).window.document;
  assert.equal(
    selected.querySelector('[aria-selected="true"]')?.getAttribute('data-activity-tab'),
    'sources'
  );
  assert.equal(
    selected.querySelector('[data-activity-view="sources"]')?.hasAttribute('hidden'),
    false
  );
  assert.equal(
    selected.querySelector('[data-activity-view="output"]')?.hasAttribute('hidden'),
    true
  );
});

test('cached activity does not advertise tools as currently running', () => {
  const { state, snapshot } = fixture();
  state.connectionState = 'busy';
  state.tools = [{ id: 'one', name: 'bash', startedAt: 1 }];
  const current = snapshot();
  current.bindingState = 'current';
  assert.match(renderActivityPanel(current), /activity-count/);
  assert.doesNotMatch(
    renderActivityPanel({ ...current, bindingState: 'cached' }),
    /activity-count/
  );
});

test('activity overlay is bounded to the pane without reserving composer width', () => {
  const css = readFileSync('src/webview/media/chat.css', 'utf8');
  const dom = new JSDOM(
    `<style>${css}</style><details class="activity-panel"><summary>Activity</summary><div class="activity-content"></div></details>`
  );
  const style = dom.window.getComputedStyle(dom.window.document.querySelector('.activity-panel')!);
  assert.equal(style.position, 'absolute');
  assert.equal(style.maxWidth, 'calc(100% - 24px)');
  assert.equal(
    dom.window.getComputedStyle(dom.window.document.querySelector('.activity-content')!).overflow,
    'auto'
  );
  assert.match(
    dom.window.getComputedStyle(dom.window.document.querySelector('.activity-content')!).maxHeight,
    /var\(--composer-clearance,\s*150px\)/,
    'the panel must reserve the measured composer height in short panes'
  );
});
