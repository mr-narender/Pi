import * as vscode from 'vscode';
import { consentedTransfer } from './consentedTransfer';
import type { SessionController } from '../sessions/sessionController';

/** Deliberately selected secret gist, never an automatic fallback from Radius. */
export async function shareCommand(
  controller: SessionController,
  args: string,
  valid: () => boolean
) {
  if (args) throw new Error('/share does not accept arguments.');
  const intent = controller.captureDeliveryIntent();
  const current = () => valid() && intent.valid();
  const payload = await intent.payload(true);
  if (!current()) return false;
  if (Buffer.byteLength(payload.jsonl) > 8 * 1024 * 1024)
    throw new Error('Share exceeds the 8 MiB limit.');
  const destination = await vscode.window.showQuickPick(
    [
      {
        label: 'GitHub secret gist',
        description: 'Anyone with the link can read it; NOT confidential',
      },
    ],
    { title: 'Choose share destination (no automatic destination switching)' }
  );
  if (!destination || !current()) return false;
  const consent = await vscode.window.showWarningMessage(
    'Upload current Pi branch to GitHub secret gist?',
    {
      modal: true,
      detail: `Includes conversation, file contents, images, tool arguments/output, cwd, system prompt and tool schemas. No paid summary. Anyone with the link can read it. GitHub authentication starts only after this confirmation. Review the exact payload below:\n${payload.jsonl}`,
    },
    'Upload'
  );
  if (consent !== 'Upload' || !current()) return false;
  try {
    const account = await vscode.authentication.getSession('github', ['gist'], {
      createIfNone: true,
    });
    if (!account || !current()) return false;
    const { response, result } = await consentedTransfer(
      'Uploading reviewed secret gist',
      current,
      async (signal) => {
        const response = await fetch('https://api.github.com/gists', {
          method: 'POST',
          signal,
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${account.accessToken}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            public: false,
            description: 'Pi session',
            files: { 'session.jsonl': { content: payload.jsonl } },
          }),
        });
        const result = (await response.json()) as { html_url?: unknown };
        return { response, result };
      }
    );
    if (!response.ok || typeof result.html_url !== 'string') throw new Error('Delivery failed.');
    const url = new URL(result.html_url);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'gist.github.com' ||
      url.username ||
      url.password ||
      !/^\/[\w-]+\/[a-f\d]+$/i.test(url.pathname)
    )
      throw new Error('Invalid delivery URL.');
    if (!current()) return false;
    // Display only. No automatic browser/clipboard effects.
    await vscode.window.showInformationMessage(`Delivered secret gist: ${url.href}`);
    return current();
  } catch {
    throw new Error(
      'Share authentication or delivery failed/cancelled. No upload success is claimed.'
    );
  }
}
