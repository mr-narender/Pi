import * as vscode from 'vscode';
import type { ChatHost, ChatTabContext } from '../editorTabs/tabManager';
import type { WebviewSnapshot } from '../state/types';

// Extracted from tabManager.ts (A2 of the de-bloat plan). Unlike A1's
// attachment-capture (genuinely pure functions), this is a cohesive
// RESPONSIBILITY — the full surface of one feature, remote chat sharing —
// that happened to live inside the ChatTabManager god object. It still
// needs read access to the chat-tab registry ChatTabManager legitimately
// owns, so that access comes in via this narrow injected interface rather
// than this service owning `hosts` itself.
export interface SharingHostAccess {
  hosts(): IterableIterator<ChatHost>;
  keyFor(resource: vscode.Uri): string;
  renderResource(resource: vscode.Uri, options?: { active?: boolean }): Promise<void>;
  activateResource(
    resource: vscode.Uri,
    options?: { startIfStopped?: boolean }
  ): Promise<ChatTabContext | undefined>;
  getActiveContext(): ChatTabContext | undefined;
}

export class RemoteSharingService {
  private remoteSink: ((snapshot: WebviewSnapshot) => void) | undefined;
  private sharing: { key: string; label: string } | undefined;

  constructor(private readonly host: SharingHostAccess) {}

  /** Register a sink that receives the active chat's snapshots (remote mirror). */
  public setRemoteSink(sink: (snapshot: WebviewSnapshot) => void): void {
    this.remoteSink = sink;
  }

  /** Force-push the active (or first open) chat's snapshot to the remote sink. */
  public async pushActiveSnapshotToRemote(): Promise<void> {
    const resource =
      this.host.getActiveContext()?.resource ?? this.host.hosts().next().value?.resource;
    if (resource) {
      await this.host.renderResource(resource, { active: true });
    }
  }

  /** Mark a chat as shared to a device; drives the in-chat info bar. */
  public async setSharing(resource: vscode.Uri, label: string): Promise<void> {
    this.sharing = { key: this.host.keyFor(resource), label };
    await this.host.renderResource(resource, { active: true });
  }

  /** Update the shared-with label (e.g. when a device connects). */
  public async updateSharingLabel(label: string): Promise<void> {
    if (!this.sharing) {
      return;
    }
    this.sharing.label = label;
    await this.rerenderSharedChat();
  }

  /** Remove the shared state and its info bar. */
  public async clearSharing(): Promise<void> {
    if (!this.sharing) {
      return;
    }
    this.sharing = undefined;
    await this.rerenderSharedChat();
  }

  private async rerenderSharedChat(): Promise<void> {
    for (const host of this.host.hosts()) {
      await this.host.renderResource(host.resource, { active: host.panel.active });
    }
  }

  /** Chats currently open in VS Code and eligible for remote switching. */
  public getRemoteChats(): Array<{ id: string; title: string; active: boolean }> {
    const active = this.host.getActiveContext()?.resource.toString();
    return [...this.host.hosts()].map((host) => ({
      id: this.host.keyFor(host.resource),
      title: host.panel.title || 'Chat',
      active: host.resource.toString() === active,
    }));
  }

  /** Switch the shared remote view to an already-open chat. */
  public async selectRemoteChat(chatId: string): Promise<boolean> {
    const host = [...this.host.hosts()].find((item) => this.host.keyFor(item.resource) === chatId);
    if (!host) {
      return false;
    }
    await this.host.activateResource(host.resource, { startIfStopped: false });
    host.panel.reveal(host.panel.viewColumn, false);
    return true;
  }

  /** Bring the shared chat to the front (after the pairing panel is dismissed). */
  public async revealSharedChat(): Promise<void> {
    if (!this.sharing) {
      return;
    }
    for (const host of this.host.hosts()) {
      if (this.host.keyFor(host.resource) === this.sharing.key) {
        host.panel.reveal(host.panel.viewColumn, false);
        await this.host.renderResource(host.resource, { active: true });
        return;
      }
    }
  }

  /**
   * Ensure a chat is open so a remote phone has a live session to mirror + drive.
   * Reveals an already-open chat if there is one; otherwise opens a fresh chat.
   */
  public async ensureActiveChat(): Promise<void> {
    if (this.host.getActiveContext()) {
      return;
    }
    const existing = this.host.hosts().next().value;
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, false);
      return;
    }
    await vscode.commands.executeCommand('piRpc.newSession');
  }

  /** Used by ChatTabManager.buildSnapshot to populate snapshot.sharing. */
  public sharingInfoFor(resource: vscode.Uri): { active: boolean; label: string } | undefined {
    if (this.sharing && this.sharing.key === this.host.keyFor(resource)) {
      return { active: true, label: this.sharing.label };
    }
    return undefined;
  }

  /** Used by ChatTabManager.renderResourceNow in place of the old direct
   * `this.remoteSink?.(snapshot)` call. */
  public pushSnapshot(snapshot: WebviewSnapshot): void {
    this.remoteSink?.(snapshot);
  }
}
