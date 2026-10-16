import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveNativeCli } from '../helpers/nativeFixture';

test('native fixtures find the pinned repository SDK without a PATH installation', async (t) => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const native = await resolveNativeCli();
  assert.equal(native.cli, await realpath(resolve('.github/pi-sdk/node_modules/.bin/pi')));
});
