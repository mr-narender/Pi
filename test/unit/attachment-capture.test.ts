import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

async function attachmentCapture(vscode: unknown) {
  const compiled = await build({
    entryPoints: ['src/editorTabs/attachmentCapture.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) => (id === 'vscode' ? vscode : require(id)),
    module,
    module.exports
  );
  return module.exports;
}

test('remote workspace files retain a relative server-readable attachment path', async () => {
  const folder = {
    uri: {
      scheme: 'vscode-remote',
      authority: 'ssh-remote+dev',
      path: '/workspace',
      toString: () => 'vscode-remote://ssh-remote+dev/workspace',
    },
  };
  const uri = {
    scheme: 'vscode-remote',
    authority: 'ssh-remote+dev',
    path: '/workspace/src/app.ts',
  };
  const api = await attachmentCapture({
    workspace: {
      getWorkspaceFolder: () => folder,
      asRelativePath: () => 'src/app.ts',
    },
  });
  assert.equal(api.relativeWorkspacePath(folder, uri), 'src/app.ts');
  assert.equal(
    api.relativeWorkspacePath(folder, { ...uri, authority: 'ssh-remote+other' }),
    undefined,
    'a URI from another remote authority must never be resolved in this workspace'
  );
});

test('pathless client drops become bounded self-contained file snapshots', async () => {
  const api = await attachmentCapture({ workspace: {} });
  const item = api.captureDroppedFile(
    { folder: { uri: { toString: () => 'vscode-remote://ssh-remote+dev/workspace' } } },
    '../report.csv',
    'a,b\n1,2'
  );
  assert.equal(item.kind, 'droppedFile');
  assert.equal(item.workspaceRelativePath, 'report.csv');
  assert.equal(item.sanitizedContent, 'a,b\n1,2');
  assert.equal(item.persistedRef.content, 'a,b\n1,2');
});
