import * as vscode from 'vscode';
import type { RecentSessionService } from '../../sessions/recentSessionService';
import type { SessionRegistry } from '../../sessions/sessionRegistry';
import { getSettings } from '../../config/settings';
import { buildSidebarState, type SidebarSessionItem, type SidebarState } from './state';

export { buildSidebarState, type SidebarSessionItem, type SidebarState };

export class SessionsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'piRpc.sessions';
  private view?: vscode.WebviewView;

  private static readonly PINNED_KEY = 'piRpc.pinnedSessions';

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly registry: SessionRegistry,
    private readonly recentSessions: RecentSessionService,
    private readonly memento?: vscode.Memento
  ) {}

  private pinnedPaths(): Set<string> {
    const raw = this.memento?.get<string[]>(SessionsWebviewProvider.PINNED_KEY, []) ?? [];
    return new Set(raw);
  }

  private async togglePin(path: string): Promise<void> {
    if (!this.memento) {
      return;
    }
    const pins = this.pinnedPaths();
    if (pins.has(path)) {
      pins.delete(path);
    } else {
      pins.add(path);
    }
    await this.memento.update(SessionsWebviewProvider.PINNED_KEY, [...pins]);
  }

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
          case 'settings':
            await vscode.commands.executeCommand('piRpcInternal.openSettingsMenu');
            break;
          case 'newChat':
            await vscode.commands.executeCommand('piRpc.newSession');
            break;
          case 'remoteStart':
            if (getSettings().remoteEnabled) {
              await vscode.commands.executeCommand('piRpc.remote.start');
            }
            break;
          case 'open':
            if (msg.sessionPath) {
              if ((msg as { other?: boolean }).other && (msg as { cwd?: string }).cwd) {
                // A chat from ANOTHER project: open it with its own cwd.
                await vscode.commands.executeCommand('piRpcInternal.openOtherChat', {
                  sessionPath: msg.sessionPath,
                  cwd: (msg as { cwd?: string }).cwd,
                });
              } else {
                await vscode.commands.executeCommand('piRpc.switchSession', {
                  sessionPath: msg.sessionPath,
                });
              }
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
          case 'pin':
            if (msg.sessionPath) {
              await this.togglePin(msg.sessionPath);
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
    this.view?.webview.postMessage({
      type: 'state',
      state: this.buildState(),
      remoteEnabled: getSettings().remoteEnabled,
    });
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
    const state = buildSidebarState(
      recent as Parameters<typeof buildSidebarState>[0],
      activePath,
      Date.now(),
      this.pinnedPaths()
    );
    // Mission Control badges: mark rows whose controller is generating (busy) or
    // blocked on an approval (waiting) so background chats are visible at a glance.
    const statusByPath = new Map<string, 'busy' | 'waiting'>();
    for (const controller of this.registry.list()) {
      const file = controller.snapshot.state.sessionFile;
      if (typeof file !== 'string') {
        continue;
      }
      const snap = controller.snapshot;
      if ((snap.pendingUi?.length ?? 0) > 0) {
        statusByPath.set(file, 'waiting');
      } else if (snap.state.isStreaming === true || snap.connectionState === 'busy') {
        statusByPath.set(file, 'busy');
      }
    }
    for (const session of state.sessions) {
      const status = statusByPath.get(session.path);
      if (status) {
        session.status = status;
      }
    }
    return state;
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
      .remote-btn {
        width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
        padding: 8px 12px; margin-top: 2px; font-size: 12.5px;
        color: var(--vscode-foreground);
        background: transparent;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px; cursor: pointer;
      }
      .remote-btn:hover { border-color: var(--pi-tool-accent, #4ec9b0); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
      .remote-btn svg { flex: 0 0 auto; }
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
      .item:hover .actions, .item.pinned .actions { display: flex; }
      .icon-btn.pin-on { color: var(--vscode-charts-yellow, #d7a300); opacity: 1; }
      .icon-btn {
        border: none; background: transparent; color: inherit; cursor: pointer;
        width: 22px; height: 22px; border-radius: 4px; font-size: 13px; line-height: 1;
      }
      .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
      .muted { opacity: 0.7; font-size: 12px; padding: 6px 8px; }
      .group-divider { margin: 10px 4px 4px; padding-top: 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.6; border-top: 1px solid var(--vscode-panel-border); }
      .stat-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
      .stat-dot.busy { background: var(--vscode-charts-orange, #d2795b); animation: sb-pulse 1s ease-in-out infinite; }
      .stat-dot.waiting { background: var(--vscode-charts-yellow, #e2b93d); animation: sb-pulse 0.7s ease-in-out infinite; }
      @keyframes sb-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
      .item.other .name { opacity: 0.92; }
    </style>
    <title>Chats</title>
  </head>
  <body>
    <div class="wrap">
      <button class="new-btn" id="new-btn" type="button" title="Start a new chat">+ New Chat</button>
      <button class="remote-btn" id="remote-btn" type="button" style="display:none" title="Watch or drive this chat from your phone"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>Connect a phone</button>
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
        let dividerDone = false;
        listEl.innerHTML = items.map((s) => {
          const divider = s.other && !dividerDone
            ? (dividerDone = true, '<div class="group-divider">Other projects</div>')
            : '';
          return divider +
          '<div class="item' + (s.active ? ' active' : '') + (s.pinned ? ' pinned' : '') + (s.other ? ' other' : '') + '" data-path="' + esc(s.path) + '" data-name="' + esc(s.name) + '"' + (s.other ? ' data-other="1" data-cwd="' + esc(s.cwd || '') + '"' : '') + '>' +
            '<div class="body">' +
              '<div class="name">' + (s.status ? '<span class="stat-dot ' + s.status + '"></span>' : '') + esc(s.name) + '</div>' +
              (s.meta ? '<div class="meta">' + esc(s.meta) + '</div>' : '') +
            '</div>' +
            '<div class="actions">' +
              '<button class="icon-btn' + (s.pinned ? ' pin-on' : '') + '" data-act="pin" title="' + (s.pinned ? 'Unpin' : 'Pin') + '">' + (s.pinned ? '\u2605' : '\u2606') + '</button>' +
              '<button class="icon-btn" data-act="rename" title="Rename">\u270e</button>' +
              '<button class="icon-btn" data-act="delete" title="Delete">\u2715</button>' +
            '</div>' +
          '</div>';
        }).join('');
      }
      document.getElementById('new-btn').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
      document.getElementById('remote-btn').addEventListener('click', () => vscode.postMessage({ type: 'remoteStart' }));
      function applyRemoteEnabled(on) {
        const btn = document.getElementById('remote-btn');
        if (btn) btn.style.display = on ? '' : 'none';
      }
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
        // Instant selection feedback: highlight the clicked item immediately,
        // before the tab finishes loading, so the click is acknowledged at once.
        document.querySelectorAll('.item.active').forEach(function (el) {
          el.classList.remove('active');
        });
        item.classList.add('active');
        vscode.postMessage({ type: 'open', sessionPath, other: item.getAttribute('data-other') === '1', cwd: item.getAttribute('data-cwd') || undefined });
      });
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'state') {
          sessions = (msg.state && msg.state.sessions) || [];
          applyRemoteEnabled(!!msg.remoteEnabled);
          render();
        }
      });
      vscode.postMessage({ type: 'refresh' });
    </script>
  </body>
</html>`;
  }
}
