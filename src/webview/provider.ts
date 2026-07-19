import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { ensureTrustedForMutation } from '../security/trust';
import { SessionRegistry } from '../sessions/sessionRegistry';
import { createWebviewSnapshot } from './model';
import { parseWebviewMessage } from './messages';
import type { JsonObject } from '../rpc/protocol';

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export class ChatPanelProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private sequence = 0;
  private subscription: vscode.Disposable | undefined;
  private pendingImages: Array<{ uri: vscode.Uri; name: string; mimeType: string; size: number }> =
    [];
  private attachmentFileUris = new Set<string>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: SessionRegistry
  ) {}

  public async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      await this.bindActiveController();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'piRpc.chat',
      'Pi RPC Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.context.extensionUri,
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ],
      }
    );
    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.onMessage(message),
      null,
      this.context.subscriptions
    );
    this.panel.onDidDispose(() => {
      this.subscription?.dispose();
      this.subscription = undefined;
      this.panel = undefined;
    });
    await this.bindActiveController();
  }

  public async refresh(): Promise<void> {
    await this.postSnapshot();
  }

  public dispose(): void {
    this.subscription?.dispose();
    this.panel?.dispose();
  }

  private async bindActiveController(): Promise<void> {
    this.subscription?.dispose();
    const controller = await this.registry.getSelectedOrPick();
    if (!controller) {
      return;
    }
    this.registry.setActive(controller);
    this.subscription = controller.onDidChangeState(() => void this.postSnapshot());
    await this.postSnapshot(controller);
  }

  private async postSnapshot(controller = this.registry.getActive()): Promise<void> {
    if (!this.panel || !controller) {
      return;
    }
    const snapshot = createWebviewSnapshot(controller.snapshot, ++this.sequence, {
      pendingImages: this.pendingImages.map(({ name, mimeType, size }) => ({
        name,
        mimeType,
        size,
      })),
      isTrusted: vscode.workspace.isTrusted,
      folders: this.registry.list().map((item) => ({
        name: item.folder.name,
        uri: item.folder.uri.toString(),
        active: item.folder.uri.toString() === this.registry.getActive()?.folder.uri.toString(),
      })),
    });
    this.attachmentFileUris = new Set(
      snapshot.messages.flatMap((message) =>
        message.attachments
          .map((attachment) => attachment.fileRef?.uri)
          .filter((uri): uri is string => typeof uri === 'string')
      )
    );
    this.panel.title = snapshot.title;
    await this.panel.webview.postMessage({ type: 'snapshot', snapshot });
  }

  private async onMessage(message: unknown): Promise<void> {
    const controller = this.registry.getActive();
    const parsed = parseWebviewMessage(message);
    if (!controller || !parsed) {
      return;
    }
    switch (parsed.type) {
      case 'send': {
        ensureTrustedForMutation();
        controller.setDraft(parsed.text);
        if (controller.snapshot.connectionState === 'stopped') {
          await controller.start();
        }
        const images = await this.loadPendingImages();
        await controller.prompt(parsed.text, parsed.mode, images);
        controller.setDraft('');
        this.pendingImages = [];
        await this.postSnapshot(controller);
        return;
      }
      case 'abort':
        await controller.abort();
        return;
      case 'refresh':
        await controller.reconcile();
        return;
      case 'setDraft':
        controller.setDraft(parsed.text);
        return;
      case 'executeCommand':
        await vscode.commands.executeCommand(parsed.command, parsed.argument);
        return;
      case 'pickImages':
        await this.pickImages();
        return;
      case 'clearImages':
        this.pendingImages = [];
        await this.postSnapshot(controller);
        return;
      case 'appendActiveFile':
        controller.setDraft(`${controller.snapshot.draft}${await this.activeFileContext()}`.trim());
        return;
      case 'appendSelection':
        controller.setDraft(`${controller.snapshot.draft}${this.activeSelectionContext()}`.trim());
        return;
      case 'appendDiagnostics':
        controller.setDraft(
          `${controller.snapshot.draft}${this.activeDiagnosticsContext()}`.trim()
        );
        return;
      case 'appendPickedFile':
        controller.setDraft(`${controller.snapshot.draft}${await this.pickedFileContext()}`.trim());
        return;
      case 'openAttachment':
        if (!this.attachmentFileUris.has(parsed.uri)) {
          return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(parsed.uri, true));
        return;
      case 'switchFolder': {
        const selected = this.registry.setActive(parsed.folderUri);
        if (selected) {
          await this.bindActiveController();
        }
        return;
      }
      default:
        return;
    }
  }

  private async pickImages(): Promise<void> {
    const settings = getSettings();
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
    });
    if (!picked) {
      return;
    }
    const selected: Array<{ uri: vscode.Uri; name: string; mimeType: string; size: number }> = [];
    for (const uri of picked.slice(0, settings.maxImagesPerPrompt)) {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > settings.maxImageBytes) {
        void vscode.window.showWarningMessage(
          `${uri.path} exceeds the configured image size limit.`
        );
        continue;
      }
      const lower = uri.path.toLowerCase();
      const extension = Object.keys(IMAGE_MIME_BY_EXTENSION).find((suffix) =>
        lower.endsWith(suffix)
      );
      selected.push({
        uri,
        name: uri.path.split('/').at(-1) ?? uri.path,
        mimeType: extension
          ? (IMAGE_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream')
          : 'application/octet-stream',
        size: stat.size,
      });
    }
    this.pendingImages = selected;
    await this.postSnapshot();
  }

  private async loadPendingImages(): Promise<JsonObject[]> {
    const images: JsonObject[] = [];
    for (const image of this.pendingImages) {
      const bytes = await vscode.workspace.fs.readFile(image.uri);
      images.push({
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: image.mimeType,
      });
    }
    return images;
  }

  private async activeFileContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '';
    }
    const text = editor.document.getText();
    return `\n\n[File: ${editor.document.uri.fsPath}]\n\n\
\
${text.slice(0, 4000)}\n\
\
`;
  }

  private activeSelectionContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return '';
    }
    const text = editor.document.getText(editor.selection);
    return `\n\n[Selection: ${editor.document.uri.fsPath}]\n\n\
\
${text.slice(0, 4000)}\n\
\
`;
  }

  private activeDiagnosticsContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '';
    }
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
    if (diagnostics.length === 0) {
      return '\n\n[Diagnostics]\nNo diagnostics.';
    }
    const summary = diagnostics
      .slice(0, 20)
      .map((item) => {
        const severity =
          item.severity === vscode.DiagnosticSeverity.Error
            ? 'error'
            : item.severity === vscode.DiagnosticSeverity.Warning
              ? 'warning'
              : 'info';
        return `${severity} L${item.range.start.line + 1}: ${item.message}`;
      })
      .join('\n');
    return `\n\n[Diagnostics]\n${summary}`;
  }

  private async pickedFileContext(): Promise<string> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false });
    if (!picked?.[0]) {
      return '';
    }
    const document = await vscode.workspace.openTextDocument(picked[0]);
    return `\n\n[File: ${document.uri.fsPath}]\n\n\
\
${document.getText().slice(0, 4000)}\n\
\
`;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'chat.css')
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "font-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Pi RPC Chat</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
