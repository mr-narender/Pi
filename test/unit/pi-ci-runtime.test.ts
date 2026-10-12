import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const yaml = createRequire(resolve('package.json'))('js-yaml');
const workflow = yaml.load(readFileSync('.github/workflows/pi.yml', 'utf8'));
// Verified official action.yml files declare node24 at these reviewed release commits.
const runtimePins = new Map([
  ['actions/checkout', 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'],
  ['actions/setup-node', 'a0853c24544627f65ddf259abe73b1d18a591444'],
  ['actions/upload-artifact', 'b7c566a772e6b6bfb58ed0dc250532a479d7789f'],
  ['actions/download-artifact', '37930b1c2abaa49bbe596cd826c3c89aef350131'],
]);

test('Pi CI pins reviewed native Node 24 actions without runtime forcing', () => {
  const seen = new Set<string>();
  for (const job of Object.values(workflow.jobs) as any[]) {
    for (const step of job.steps) {
      if (!step.uses) continue;
      const [action, pin] = step.uses.split('@');
      if (runtimePins.has(action)) {
        assert.equal(
          pin,
          runtimePins.get(action),
          `${action} must use its reviewed native Node 24 release`
        );
        seen.add(action);
      }
    }
  }
  assert.equal(seen.size, runtimePins.size);
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24|ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION/
  );
});

test('Azure login receives JSON for its private version parser while publication stays quiet', () => {
  const release = workflow.jobs.release;
  const login = release.steps.find((step: any) => step.uses?.startsWith('azure/login@'));
  const publish = release.steps.find((step: any) => step.name === 'Publish the verified artifact');
  assert.equal(login.env.AZURE_CORE_OUTPUT, 'json');
  assert.equal(release.env.AZURE_CORE_OUTPUT, 'none');
  assert.equal(publish.env.AZURE_CORE_OUTPUT, undefined);
  assert.equal(login.env.AZURE_CONFIG_DIR, publish.env.AZURE_CONFIG_DIR);
  assert.equal(login.with['allow-no-subscriptions'], true);
  assert.deepEqual(release.permissions, {
    contents: 'write',
    'id-token': 'write',
    actions: 'read',
  });
});
