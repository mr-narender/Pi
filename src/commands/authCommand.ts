import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';

export async function authCommand(
  controller: SessionController,
  name: 'logout' | 'login',
  args: string,
  valid: () => boolean,
  mutate: (action: () => Promise<void>) => Promise<boolean>
) {
  if (args) throw new Error(`/${name} does not accept arguments.`);
  const intent = controller.captureAuthIntent();
  let cancelled = false;
  const current = () => !cancelled && valid() && intent.valid();
  const providers = await intent.providers();
  if (!current()) return false;
  const items = providers
    .filter((p) =>
      name === 'logout' ? p.stored === true : Array.isArray(p.types) && p.types.length > 0
    )
    .map((p) => ({
      label: String(p.name),
      description: String(p.providerId),
      providerId: String(p.providerId),
    }));
  if (!items.length)
    throw new Error(
      'No stored provider credentials to remove. Environment and models.json configuration are unchanged.'
    );
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Remove stored Pi credential',
  });
  if (!selected || !current()) return false;
  let authType: string | undefined;
  if (name === 'login') {
    const provider = providers.find((p) => p.providerId === selected.providerId);
    const method = await vscode.window.showQuickPick(
      (provider?.types as string[]).map((type) => ({ label: type, type })),
      { title: 'Choose authentication method' }
    );
    if (!method || !current()) return false;
    authType = method.type;
  }
  const action = name === 'logout' ? 'Remove credential' : 'Authenticate';
  const consent = await vscode.window.showWarningMessage(
    name === 'logout'
      ? `Remove the stored ${selected.label} credential globally? Available models in all chats may change. This does not revoke the account token or remove environment/models.json credentials.`
      : `Authenticate with ${selected.label}? This may contact the selected provider and replace its global stored credential. Model availability changes in all chats; this GUI does NOT change your current model or native defaults. Browser opening requires a separate click.`,
    { modal: true },
    action
  );
  if (consent !== action || !current()) return false;
  const interact = async (
    data: import('../rpc/protocol').JsonObject,
    token?: vscode.CancellationToken
  ): Promise<string | null> => {
    if (!current()) return null;
    const prompt = data.prompt as import('../rpc/protocol').JsonObject | undefined;
    if (prompt) {
      if (prompt.type === 'select') {
        const options = (prompt.options as import('../rpc/protocol').JsonObject[]).map(
          (option) => ({ label: String(option.label), id: String(option.id) })
        );
        const result = await vscode.window.showQuickPick(
          options,
          {
            title: String(prompt.message),
          },
          token
        );
        return current() ? (result?.id ?? null) : null;
      }
      const result = await vscode.window.showInputBox(
        {
          title: String(prompt.message),
          placeHolder: String(prompt.placeholder ?? ''),
          password: true,
          ignoreFocusOut: false,
        },
        token
      );
      return current() ? (result ?? null) : null;
    }
    const event = data.event as import('../rpc/protocol').JsonObject | undefined;
    if (event?.type === 'auth_url' || event?.type === 'device_code') {
      let url: URL;
      try {
        url = new URL(String(event.url ?? event.verificationUri));
      } catch {
        cancelled = true;
        return null;
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        cancelled = true;
        return null;
      }
      const open = await vscode.window.showWarningMessage(
        `Authentication at ${url.origin}${event.type === 'device_code' ? ` — device code: ${event.userCode}` : ''}`,
        { modal: true },
        'Open provider browser'
      );
      if (current() && open === 'Open provider browser')
        await vscode.env.openExternal(vscode.Uri.parse(url.href));
      else cancelled = true;
    }
    return null;
  };
  let applied = false;
  const accepted = await mutate(async () => {
    if (!current()) return;
    if (name === 'logout') {
      applied = await intent.run(name, selected.providerId);
      return;
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Provider authentication',
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => {
          cancelled = true;
          abort.abort();
        });
        try {
          if (token.isCancellationRequested) {
            cancelled = true;
            abort.abort();
          }
          if (current())
            applied = await intent.run(
              name,
              selected.providerId,
              authType,
              interact,
              current,
              abort.signal
            );
        } finally {
          cancellation.dispose();
        }
      }
    );
  });
  return accepted && applied && current();
}
