import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  predictNextFiles,
  resolveLocalImport,
  scanImportSpecifiers,
} from '../../src/live/importScan';

test('scanImportSpecifiers: TS import/require/export, ignores non-matches', () => {
  const source = `
    import { foo } from './utils';
    import bar from "../lib/bar";
    const x = require('./legacy');
    export { z } from './z';
    import lodash from 'lodash';
  `;
  const specs = scanImportSpecifiers(source, 'typescript');
  assert.deepEqual(specs.sort(), ['../lib/bar', './legacy', './utils', './z', 'lodash'].sort());
});

test('scanImportSpecifiers: python from/import', () => {
  const source = 'from .models import User\nimport os\nfrom ..pkg import thing\n';
  const specs = scanImportSpecifiers(source, 'python');
  assert.deepEqual(specs.sort(), ['..pkg', '.models', 'os'].sort());
});

test('resolveLocalImport + predictNextFiles: only resolves files that actually exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-importscan-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'utils.ts'), 'export const x = 1;');
  writeFileSync(join(dir, 'lib', 'bar.ts'), 'export const y = 2;');
  const fromFile = join(dir, 'app.ts');
  writeFileSync(
    fromFile,
    `import { x } from './utils';\nimport { y } from './lib/bar';\nimport lodash from 'lodash';\nimport { z } from './missing';\n`
  );
  assert.equal(resolveLocalImport('./utils', fromFile, 'typescript'), join(dir, 'utils.ts'));
  assert.equal(resolveLocalImport('lodash', fromFile, 'typescript'), undefined);
  assert.equal(resolveLocalImport('./missing', fromFile, 'typescript'), undefined);

  const predicted = predictNextFiles(
    require('node:fs').readFileSync(fromFile, 'utf8'),
    fromFile,
    'typescript'
  );
  assert.deepEqual(predicted.sort(), [join(dir, 'utils.ts'), join(dir, 'lib', 'bar.ts')].sort());
});
