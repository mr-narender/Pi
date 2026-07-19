declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

import type { WebviewSnapshot } from '../../state/types';
import { renderChatApp } from '../render';

const vscode = acquireVsCodeApi();
const root = document.getElementById('app');

function render(snapshot: WebviewSnapshot): void {
  if (!root) {
    return;
  }
  root.innerHTML = renderChatApp(snapshot);

  const textarea = document.getElementById('draft') as HTMLTextAreaElement | null;
  textarea?.addEventListener('input', () => {
    vscode.postMessage({ type: 'setDraft', text: textarea.value });
  });
  document.getElementById('folder-select')?.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    vscode.postMessage({ type: 'switchFolder', folderUri: target.value });
  });
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-mode]'))) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'send', mode: button.dataset.mode, text: textarea?.value ?? '' });
    });
  }
  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-action]')
  )) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: button.dataset.action });
    });
  }
  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-command]')
  )) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'executeCommand', command: button.dataset.command });
    });
  }
  for (const button of Array.from(
    root.querySelectorAll<HTMLButtonElement>('button[data-attachment-uri]')
  )) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'openAttachment', uri: button.dataset.attachmentUri });
    });
  }
  bindForms();
}

function bindForms(): void {
  bindForm('status-form', () => {
    const key = (document.getElementById('status-key') as HTMLInputElement | null)?.value ?? '';
    const text = (document.getElementById('status-text') as HTMLInputElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.extensionUi.setStatus',
      argument: { key, text },
    });
  });
  bindForm('widget-form', () => {
    const key = (document.getElementById('widget-key') as HTMLInputElement | null)?.value ?? '';
    const placement =
      (document.getElementById('widget-placement') as HTMLSelectElement | null)?.value ??
      'aboveEditor';
    const lines =
      (document.getElementById('widget-lines') as HTMLTextAreaElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.extensionUi.setWidget',
      argument: { key, placement, lines },
    });
  });
  bindForm('rename-session-form', () => {
    const name =
      (document.getElementById('rename-session-name') as HTMLInputElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.renameSession',
      argument: { name },
    });
  });
  bindForm('bash-form', () => {
    const command =
      (document.getElementById('bash-command') as HTMLInputElement | null)?.value ?? '';
    const exclude =
      (document.getElementById('bash-exclude') as HTMLInputElement | null)?.checked ?? false;
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.runBash',
      argument: { command, excludeFromContext: exclude },
    });
  });
  bindForm('title-form', () => {
    const title = (document.getElementById('chat-title') as HTMLInputElement | null)?.value ?? '';
    vscode.postMessage({
      type: 'executeCommand',
      command: 'piRpc.extensionUi.setTitle',
      argument: { title },
    });
  });
}

function bindForm(id: string, onSubmit: () => void): void {
  root?.querySelector<HTMLFormElement>(`#${id}`)?.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit();
  });
}

window.addEventListener(
  'message',
  (event: MessageEvent<{ type: string; snapshot: WebviewSnapshot }>) => {
    if (event.data?.type === 'snapshot') {
      render(event.data.snapshot);
    }
  }
);
