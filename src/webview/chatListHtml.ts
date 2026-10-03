import * as vscode from 'vscode';

// Agentic Mode chat list — a small, dedicated webview bundle (chatList.js),
// deliberately NOT sharing the chat.ts runtime. The list is simple enough
// that reusing the ~2000-line chat rendering pipeline would mean threading
// a second render mode through code that already carries real complexity;
// keeping this as its own tiny bundle is the smaller, safer diff. Shares
// chat.css so the ember/glass tokens stay one source of truth.
export function renderChatListWebviewHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  buildTag = ''
): string {
  const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
  const bust = buildTag ? `?v=${encodeURIComponent(buildTag)}` : '';
  const scriptUri = `${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'chatList.js'))}${bust}`;
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
    <title>Chats</title>
  </head>
  <body class="chat-list-view">
    <div id="app"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
