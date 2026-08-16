import * as vscode from 'vscode';

export function renderChatWebviewHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  title = 'Pi Chat',
  buildTag = ''
): string {
  const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
  const bust = buildTag ? `?v=${encodeURIComponent(buildTag)}` : '';
  const scriptUri = `${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'chat.js'))}${bust}`;
  const styleUri = `${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'chat.css'))}${bust}`;
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
    <title>${title}</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
