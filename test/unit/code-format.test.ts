import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORMAT_MAX_CHARS,
  applyTextEditsToString,
  collectCodeFences,
  formatKey,
  isFormattableBlock,
} from '../../src/webview/codeFormat';

test('formatKey: stable per (language, code); diverges on either changing', () => {
  const key = formatKey('ts', 'const a=1;');
  assert.equal(key, formatKey('ts', 'const a=1;'));
  assert.equal(key, formatKey(' TS ', 'const a=1;'), 'language normalized');
  assert.notEqual(key, formatKey('js', 'const a=1;'));
  assert.notEqual(key, formatKey('ts', 'const a=2;'));
});

test('isFormattableBlock: bounds — empty and oversized blocks never format', () => {
  assert.equal(isFormattableBlock('ts', 'const a=1;'), true);
  assert.equal(isFormattableBlock('ts', '   \n  '), false);
  assert.equal(isFormattableBlock('ts', 'x'.repeat(FORMAT_MAX_CHARS + 1)), false);
  assert.equal(isFormattableBlock(undefined, 'const a=1;'), true, 'untagged fences may format');
});

test('collectCodeFences: extracts language + code; skips JSON-table fences', () => {
  const text = [
    'Here is code:',
    '```ts',
    'const a=1;',
    'const b=2;',
    '```',
    'and JSON:',
    '```json',
    '{"a": 1}',
    '```',
    'and an untagged JSON object:',
    '```',
    '{"b": 2}',
    '```',
    'and shell:',
    '```sh',
    'ls -la',
    '```',
  ].join('\n');
  const blocks = collectCodeFences(text);
  assert.deepEqual(blocks, [
    { language: 'ts', code: 'const a=1;\nconst b=2;' },
    { language: 'sh', code: 'ls -la' },
  ]);
});

test('collectCodeFences: unterminated fence and empty input are safe', () => {
  assert.deepEqual(collectCodeFences(''), []);
  const blocks = collectCodeFences('```py\nprint(1)');
  assert.deepEqual(blocks, [{ language: 'py', code: 'print(1)' }]);
});

test('applyTextEditsToString: single replace, multi-line ranges', () => {
  const text = 'const a=1;\nconst b=2;';
  const edits = [
    {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
      newText: 'a ',
    },
  ];
  assert.equal(applyTextEditsToString(text, edits), 'const a =1;\nconst b=2;');
});

test('applyTextEditsToString: unsorted edits apply correctly (sorted internally)', () => {
  const text = 'ab\ncd';
  const edits = [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'A' },
    { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, newText: 'D' },
  ];
  assert.equal(applyTextEditsToString(text, [edits[1]!, edits[0]!]), 'Ab\ncD');
});

test('applyTextEditsToString: whole-document replace (the common formatter shape)', () => {
  const text = 'const a=1;\nconst b=2;';
  const edits = [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 10 } },
      newText: 'const a = 1;\nconst b = 2;\n',
    },
  ];
  assert.equal(applyTextEditsToString(text, edits), 'const a = 1;\nconst b = 2;\n');
});

test('applyTextEditsToString: out-of-range positions clamp instead of corrupting', () => {
  const text = 'ab';
  const edits = [
    { range: { start: { line: 5, character: 0 }, end: { line: 9, character: 9 } }, newText: '!' },
  ];
  assert.equal(applyTextEditsToString(text, edits), 'ab!');
  assert.equal(applyTextEditsToString('ab', []), 'ab');
});
