import * as vscode from 'vscode';
import type { ExtensionUiRequest } from '../rpc/protocol';
import { SessionRegistry } from '../sessions/sessionRegistry';
import type { SessionController } from '../sessions/sessionController';

export class ExtensionUiBroker implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(private readonly registry: SessionRegistry) {
    for (const controller of registry.list()) {
      this.track(controller);
    }
  }

  public track(controller: SessionController): void {
    this.subscriptions.push(
      controller.onDidReceiveExtensionUiRequest(
        (request) => void this.handleRequest(controller, request, { respond: true })
      )
    );
  }

  public async previewRequest(
    controller: SessionController,
    request: ExtensionUiRequest
  ): Promise<unknown> {
    controller.applyExtensionUiRequest(request);
    const result = await this.handleRequest(controller, request, { respond: false });
    if (
      request.method === 'select' ||
      request.method === 'confirm' ||
      request.method === 'input' ||
      request.method === 'editor'
    ) {
      controller.completeExtensionUiRequest(request.id);
    }
    return result;
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async handleRequest(
    controller: SessionController,
    request: ExtensionUiRequest,
    options: { respond: boolean }
  ): Promise<unknown> {
    switch (request.method) {
      case 'notify': {
        const message = request.message ?? 'Pi notification';
        if (request.notifyType === 'error') {
          void vscode.window.showErrorMessage(message);
        } else if (request.notifyType === 'warning') {
          void vscode.window.showWarningMessage(message);
        } else {
          void vscode.window.showInformationMessage(message);
        }
        return { shown: true };
      }
      case 'select': {
        const picked = await this.runQuickPick(
          request,
          (request.options ?? []).map((label) => ({ label })),
          request.title
        );
        if (options.respond) {
          await controller.respondExtensionUi(
            picked ? { id: request.id, value: picked.label } : { id: request.id, cancelled: true }
          );
          controller.completeExtensionUiRequest(request.id);
        }
        return picked ? picked.label : { cancelled: true };
      }
      case 'confirm': {
        const picked = await this.runQuickPick(
          request,
          [{ label: 'Yes' }, { label: 'No' }],
          request.title,
          request.message
        );
        if (options.respond) {
          await controller.respondExtensionUi(
            picked
              ? { id: request.id, confirmed: picked.label === 'Yes' }
              : { id: request.id, cancelled: true }
          );
          controller.completeExtensionUiRequest(request.id);
        }
        return picked ? { confirmed: picked.label === 'Yes' } : { cancelled: true };
      }
      case 'input': {
        const value = await this.runInputBox(request);
        if (options.respond) {
          await controller.respondExtensionUi(
            value === undefined ? { id: request.id, cancelled: true } : { id: request.id, value }
          );
          controller.completeExtensionUiRequest(request.id);
        }
        return value === undefined ? { cancelled: true } : { value };
      }
      case 'editor': {
        const doc = await vscode.workspace.openTextDocument({
          content: request.prefill ?? '',
          language: 'markdown',
        });
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        const action = await vscode.window.showInformationMessage(
          request.title ?? 'Submit editor text',
          { modal: true },
          'Submit',
          'Cancel'
        );
        const result =
          action === 'Submit' ? { value: doc.getText() } : ({ cancelled: true } as const);
        if (options.respond) {
          await controller.respondExtensionUi(
            action === 'Submit'
              ? { id: request.id, value: doc.getText() }
              : { id: request.id, cancelled: true }
          );
          controller.completeExtensionUiRequest(request.id);
        }
        return result;
      }
      case 'set_editor_text': {
        const current = controller.snapshot.draft;
        if (current && current !== request.text) {
          const choice = await vscode.window.showQuickPick(
            ['Replace draft', 'Append to draft', 'Cancel'],
            {
              title: 'Pi wants to modify the composer draft',
            }
          );
          if (choice === 'Replace draft') {
            controller.setDraft(request.text ?? '');
            return { replaced: true };
          }
          if (choice === 'Append to draft') {
            controller.setDraft(`${current}\n${request.text ?? ''}`.trim());
            return { appended: true };
          }
          return { cancelled: true };
        }
        controller.setDraft(request.text ?? '');
        return { replaced: true };
      }
      case 'setStatus':
      case 'setWidget':
      case 'setTitle':
        return { updated: true };
      default:
        return undefined;
    }
  }

  private async runQuickPick(
    request: ExtensionUiRequest,
    items: Array<{ label: string }>,
    title?: string,
    detail?: string
  ): Promise<{ label: string } | undefined> {
    return new Promise((resolve) => {
      const quickPick = vscode.window.createQuickPick<{ label: string }>();
      quickPick.items = items;
      quickPick.title = title;
      quickPick.placeholder = detail;
      quickPick.ignoreFocusOut = true;
      let done = false;
      const finish = (value: { label: string } | undefined): void => {
        if (done) {
          return;
        }
        done = true;
        timer && clearTimeout(timer);
        quickPick.hide();
        quickPick.dispose();
        resolve(value);
      };
      quickPick.onDidAccept(() => finish(quickPick.selectedItems[0]));
      quickPick.onDidHide(() => finish(undefined));
      const timer =
        typeof request.timeout === 'number' && request.timeout > 0
          ? setTimeout(() => finish(undefined), request.timeout)
          : undefined;
      quickPick.show();
    });
  }

  private async runInputBox(request: ExtensionUiRequest): Promise<string | undefined> {
    return new Promise((resolve) => {
      const input = vscode.window.createInputBox();
      input.title = request.title;
      input.placeholder = request.placeholder;
      input.ignoreFocusOut = true;
      let done = false;
      const finish = (value: string | undefined): void => {
        if (done) {
          return;
        }
        done = true;
        timer && clearTimeout(timer);
        input.hide();
        input.dispose();
        resolve(value);
      };
      input.onDidAccept(() => finish(input.value));
      input.onDidHide(() => finish(undefined));
      const timer =
        typeof request.timeout === 'number' && request.timeout > 0
          ? setTimeout(() => finish(undefined), request.timeout)
          : undefined;
      input.show();
    });
  }
}
