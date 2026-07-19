import * as vscode from 'vscode';
import type { RecentSessionService } from '../../sessions/recentSessionService';
import type { SessionRegistry } from '../../sessions/sessionRegistry';
import { buildSidebarState, type SidebarSessionItem, type SidebarState } from './state';

export { buildSidebarState, type SidebarSessionItem, type SidebarState };

export class SessionsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'piRpc.sessions';
  private view?: vscode.WebviewView;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: SessionRegistry,
    private readonly recentSessions: RecentSessionService
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      const msg = (message ?? {}) as { type?: string; sessionPath?: string; sessionLabel?: string };
      try {
        switch (msg.type) {
          case 'newChat':
            await vscode.commands.executeCommand('piRpc.newSession');
            break;
          case 'open':
            if (msg.sessionPath) {
              await vscode.commands.executeCommand('piRpc.switchSession', {
                sessionPath: msg.sessionPath,
              });
            }
            break;
          case 'rename':
            if (msg.sessionPath) {
              await vscode.commands.executeCommand('piRpcInternal.renameSession', {
                sessionPath: msg.sessionPath,
              });
            }
            break;
          case 'delete':
            if (msg.sessionPath) {
              await vscode.commands.executeCommand('piRpcInternal.deleteSession', {
                sessionPath: msg.sessionPath,
                sessionLabel: msg.sessionLabel,
              });
            }
            break;
          case 'refresh':
            await this.recentSessions.refresh();
            break;
          default:
            break;
        }
      } finally {
        this.refresh();
      }
    });
    this.refresh();
  }

  public refresh(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.buildState() });
  }

  private buildState(): SidebarState {
    const active = this.registry.getActive();
    const recent = active
      ? this.recentSessions.getState(active.folder)
      : { loading: false, items: [] as SidebarSessionItem['path'][] };
    const activePath =
      typeof active?.snapshot.state.sessionFile === 'string'
        ? active.snapshot.state.sessionFile
        : undefined;
    return buildSidebarState(
      recent as {
        loading: boolean;
        error?: string;
        items: Array<{
          path: string;
          displayName: string;
          modifiedAt: number;
          modelLabel?: string;
        }>;
      },
      activePath
    );
  }

  private html(): string {
    const nonce = String(Date.now()) + Math.random().toString(16).slice(2);
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "img-src 'none'",
      "font-src 'none'",
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style nonce="${nonce}">
      * { box-sizing: border-box; }
      body { margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
      .wrap { display: flex; flex-direction: column; gap: 10px; padding: 10px; }
      .new-btn {
        width: 100%;
        display: flex; align-items: center; justify-content: center; gap: 8px;
        padding: 10px 12px;
        font-size: 13px; font-weight: 600;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 8px; cursor: pointer;
      }
      .new-btn:hover { background: var(--vscode-button-hoverBackground); }
      .search {
        width: 100%; padding: 6px 8px; border-radius: 6px;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      }
      .list { display: flex; flex-direction: column; gap: 2px; }
      .item {
        display: flex; align-items: center; gap: 6px;
        padding: 7px 8px; border-radius: 6px; cursor: pointer;
      }
      .item:hover { background: var(--vscode-list-hoverBackground); }
      .item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
      .item .body { flex: 1 1 auto; min-width: 0; }
      .item .name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item .meta { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item .actions { display: none; gap: 2px; }
      .item:hover .actions { display: flex; }
      .icon-btn {
        border: none; background: transparent; color: inherit; cursor: pointer;
        width: 22px; height: 22px; border-radius: 4px; font-size: 13px; line-height: 1;
      }
      .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
      .muted { opacity: 0.7; font-size: 12px; padding: 6px 8px; }
    </style>
    <title>Chats</title>
  </head>
  <body>
    <div class="wrap">
      <button class="new-btn" id="new-btn" type="button" title="Start a new chat">+ New Chat</button>
      <input class="search" id="search" type="text" placeholder="Search chats\u2026" aria-label="Search chats" />
      <div class="list" id="list"></div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      let sessions = [];
      let filter = '';
      const listEl = document.getElementById('list');
      const searchEl = document.getElementById('search');
      function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
      function render() {
        const f = filter.trim().toLowerCase();
        const items = sessions.filter((s) => !f || (s.name + ' ' + s.meta).toLowerCase().includes(f));
        if (items.length === 0) {
          listEl.innerHTML = '<div class="muted">' + (sessions.length ? 'No matching chats.' : 'No chats yet.') + '</div>';
          return;
        }
        listEl.innerHTML = items.map((s) =>
          '<div class="item' + (s.active ? ' active' : '') + '" data-path="' + esc(s.path) + '" data-name="' + esc(s.name) + '">' +
            '<div class="body">' +
              '<div class="name">' + esc(s.name) + '</div>' +
              (s.meta ? '<div class="meta">' + esc(s.meta) + '</div>' : '') +
            '</div>' +
            '<div class="actions">' +
              '<button class="icon-btn" data-act="rename" title="Rename">\u270e</button>' +
              '<button class="icon-btn" data-act="delete" title="Delete">\u2715</button>' +
            '</div>' +
          '</div>'
        ).join('');
      }
      document.getElementById('new-btn').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
      searchEl.addEventListener('input', () => { filter = searchEl.value; render(); });
      listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.icon-btn');
        const item = e.target.closest('.item');
        if (!item) return;
        const sessionPath = item.getAttribute('data-path');
        const sessionLabel = item.getAttribute('data-name');
        if (btn) {
          e.stopPropagation();
          vscode.postMessage({ type: btn.getAttribute('data-act'), sessionPath, sessionLabel });
          return;
        }
        vscode.postMessage({ type: 'open', sessionPath });
      });
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'state') { sessions = (msg.state && msg.state.sessions) || []; render(); }
      });
      vscode.postMessage({ type: 'refresh' });
    </script>
  </body>
</html>`;
  }
}
