import test from 'node:test';
import assert from 'node:assert/strict';
import { vscodeLanguageId } from '../../src/editorTabs/languageId';

test('vscodeLanguageId maps common fence aliases to VS Code language ids', () => {
  assert.equal(vscodeLanguageId('ts'), 'typescript');
  assert.equal(vscodeLanguageId('TSX'), 'typescriptreact');
  assert.equal(vscodeLanguageId('py'), 'python');
  assert.equal(vscodeLanguageId('bash'), 'shellscript');
  assert.equal(vscodeLanguageId('c++'), 'cpp');
});

test('vscodeLanguageId passes through already-valid ids and drops generic labels', () => {
  assert.equal(vscodeLanguageId('python'), 'python');
  assert.equal(vscodeLanguageId('rust'), 'rust');
  assert.equal(vscodeLanguageId('text'), undefined);
  assert.equal(vscodeLanguageId('code'), undefined);
  assert.equal(vscodeLanguageId(''), undefined);
  assert.equal(vscodeLanguageId(undefined), undefined);
});
