import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Every command contributed in package.json MUST be wired through the central
// `registrations` map — activation HARD-FAILS on any miss (self-check in
// extension.ts). This static test catches it at gate time instead of at the
// user's next window reload. (Born from the 0.0.234 review-panel outage.)
function allSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      allSources(path, out);
    } else if (entry.endsWith('.ts')) {
      out.push(readFileSync(path, 'utf8'));
    }
  }
  return out;
}

test('every contributed command has a registrations.set handler', () => {
  const root = join(__dirname, '..', '..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    contributes: { commands: Array<{ command: string }> };
  };
  const sources = allSources(join(root, 'src')).join('\n');
  const missing = manifest.contributes.commands
    .map((entry) => entry.command)
    .filter(
      (id) =>
        !sources.includes(`registrations.set('${id}'`) &&
        !sources.includes(`registrations.set(\n    '${id}'`) &&
        // reviewTree-style handler maps wired via Object.entries(...).
        !sources.includes(`'${id}': async`)
    );
  assert.deepEqual(
    missing,
    [],
    `commands with no registrations.set handler: ${missing.join(', ')}`
  );
});
