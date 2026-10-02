import * as vscode from 'vscode';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionController } from '../sessions/sessionController';

/** No SDK import, PATH discovery, installation, provider call or internal parser. */
async function boundedFile(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > limit)
      throw new Error('Expected a nonempty bounded regular file.');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('File exceeds the local preview limit.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function changelogCommand(
  controller: SessionController,
  args: string,
  valid: () => boolean
): Promise<boolean> {
  if (args) throw new Error('/changelog does not accept arguments.');
  // This root was captured from the actual launched handle, not current settings.
  const selected = controller.sdkRoot;
  if (!selected)
    throw new Error(
      'Selected Pi engine package root is unknown (stock/custom wrapper). No unrelated SDK changelog was substituted.'
    );
  const check = () => {
    if (!valid()) throw new Error('The originating chat changed; changelog cancelled.');
  };
  check();
  let content: string;
  let version: string;
  try {
    const root = await realpath(selected);
    check();
    const pkg = JSON.parse(await boundedFile(join(root, 'package.json'), 64 * 1024)) as {
      name?: string;
      version?: string;
      bin?: { pi?: string };
    };
    if (
      pkg.name !== '@earendil-works/pi-coding-agent' ||
      !['0.99.1', '0.99.2', '1.0.0'].includes(pkg.version ?? '') ||
      !['dist/cli.js', 'dist/bundle/cli.js'].includes(pkg.bin?.pi ?? '')
    )
      throw new Error('Unverified Pi package metadata.');
    version = pkg.version!;
    content = await boundedFile(join(root, 'CHANGELOG.md'), 2 * 1024 * 1024);
    if (
      !/^# Changelog\s*$/m.test(content) ||
      !content
        .split('\n')
        .some(
          (line) =>
            line.startsWith(`## [${version}]`) ||
            line === `## ${version}` ||
            line.startsWith(`## ${version} `)
        )
    )
      throw new Error('Unexpected engine changelog content.');
  } catch {
    throw new Error(
      'Selected Pi engine changelog unavailable: package/file verification failed (missing, unsupported, nonregular or over 2 MiB). No PATH fallback was used.'
    );
  }
  check();
  const choice = await vscode.window.showInformationMessage(
    `Pi engine ${version} changelog`,
    {
      modal: true,
      detail:
        'Open the selected engine’s local Markdown preview. No browser or network is opened automatically. Links require an explicit click and standard VS Code security.',
    },
    'Open Preview'
  );
  check();
  if (choice !== 'Open Preview') return false;
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# Pi engine ${version}\n\n${content}`,
  });
  check();
  await vscode.commands.executeCommand('markdown.showPreview', document.uri);
  return valid();
}
