// A persistent webview panel that shows the remote-session pairing QR + PIN +
// link. Replaces the transient notification (which vanished, taking the PIN with
// it) so the pairing details stay visible until the session is stopped.

import * as vscode from 'vscode';
import QRCode from 'qrcode';

export interface PairingInfo {
  link: string;
  pin: string;
  sessionId: string;
  expiresAt: number;
}

interface Handlers {
  onStop: () => void;
  onCopy: (text: string) => void;
}

let panel: vscode.WebviewPanel | undefined;
let current: PairingInfo | undefined;

export async function showPairingPanel(info: PairingInfo, handlers: Handlers): Promise<void> {
  current = info;
  const qr = await QRCode.toString(info.link, {
    type: 'svg',
    margin: 1,
    color: { dark: '#e6edf3', light: '#0000' },
  });
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'piRemotePairing',
      'Pi — Remote Session',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => {
      panel = undefined;
      handlers.onStop();
    });
    panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'copy' && current) {
        handlers.onCopy(current.link);
      } else if (message?.type === 'stop') {
        panel?.dispose();
      }
    });
  }
  panel.webview.html = html(qr, info);
  panel.reveal(vscode.ViewColumn.Beside, false);
}

/** Update the live status line (e.g. when a phone connects). */
export function setPairingStatus(text: string, connected: boolean): void {
  void panel?.webview.postMessage({ type: 'status', text, connected });
}

export function closePairingPanel(): void {
  const p = panel;
  panel = undefined;
  current = undefined;
  p?.dispose();
}

function html(qrSvg: string, info: PairingInfo): string {
  const pinDigits = info.pin
    .split('')
    .map((d) => `<span class="d">${d}</span>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root{--fg:var(--vscode-foreground);--muted:var(--vscode-descriptionForeground);--teal:#4ec9b0;--border:var(--vscode-panel-border);--bg:var(--vscode-editor-background);}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:var(--vscode-font-family);color:var(--fg);background:var(--bg);}
  .wrap{width:100%;max-width:420px;margin:0 auto;padding:26px 22px;text-align:center;}
  .state{display:inline-flex;align-items:center;gap:8px;margin:0 0 18px;padding:7px 14px;border:1px solid var(--border);border-radius:999px;font-size:13px;color:var(--muted);}
  .state::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--muted);}
  .state.connected{color:var(--teal);border-color:rgba(78,201,176,.4);}
  .state.connected::before{background:var(--teal);}
  h1{font-size:18px;margin:0 0 4px;}
  .sub{color:var(--muted);margin:0 0 20px;font-size:13px;line-height:1.5;}
  .qr{width:220px;height:220px;margin:0 auto 20px;padding:14px;border:1px solid var(--border);border-radius:16px;background:rgba(127,127,127,.06);}
  .qr svg{width:100%;height:100%;}
  .label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px;}
  .pin{display:flex;gap:8px;justify-content:center;margin:0 0 22px;}
  .pin .d{width:40px;height:52px;display:grid;place-items:center;font-size:26px;font-weight:700;border:1px solid var(--border);border-radius:10px;background:rgba(78,201,176,.08);color:var(--teal);font-variant-numeric:tabular-nums;}
  .link{display:flex;gap:8px;align-items:center;margin:0 0 18px;}
  .link input{flex:1;padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:12px;}
  button{font:inherit;cursor:pointer;border-radius:8px;padding:9px 14px;border:1px solid var(--border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}
  button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent;}
  .row{display:flex;gap:10px;justify-content:center;}
  .steps{text-align:left;color:var(--muted);font-size:12.5px;line-height:1.7;margin:20px auto 0;max-width:320px;}
  .steps b{color:var(--fg);}
</style></head><body>
  <div class="wrap">
    <h1>Connect your phone</h1>
    <p class="sub">Scan the QR (or open the link) on your phone, then enter the PIN below.</p>
    <div><span id="state" class="state">Waiting for a device…</span></div>
    <div class="qr">${qrSvg}</div>
    <p class="label">PIN</p>
    <div class="pin">${pinDigits}</div>
    <div class="link">
      <input id="lnk" readonly value="${escapeAttr(info.link)}" />
      <button class="primary" onclick="post('copy')">Copy</button>
    </div>
    <div class="row"><button onclick="post('stop')">Stop session</button></div>
    <div class="steps">
      <b>1.</b> Scan the QR or open the link on your phone.<br/>
      <b>2.</b> Enter the 6‑digit PIN above.<br/>
      <b>3.</b> Watch live — tap <b>Take control</b> to drive.
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    function post(type){ vscode.postMessage({type}); }
    window.addEventListener('message', function(e){
      var d = e.data || {};
      if (d.type === 'status') {
        var el = document.getElementById('state');
        el.textContent = d.text;
        el.className = 'state' + (d.connected ? ' connected' : '');
      }
    });
  </script>
</body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
