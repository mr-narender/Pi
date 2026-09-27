import * as vscode from 'vscode';
import { basename } from 'node:path';
import {
  boundDiagnosticsContent,
  boundFileContent,
  fingerprint,
  type PendingContextItem,
} from '../webview/composer';
import type { SessionController } from '../sessions/sessionController';

// Extracted from tabManager.ts (A1 of the de-bloat plan — see plan turn):
// everything here takes a `controller`/`document` as an explicit parameter
// and has ZERO dependency on ChatTabManager instance state (`this`). Verified
// by reading every call site before moving anything — each function was
// already pure given its inputs, just physically nested inside the god
// class. Same "pure logic, no vscode-instance-state" boundary already used
// elsewhere in this codebase (hunks.ts vs inlineReview.ts, approvalGate.ts
// vs approvalGateSettings.ts).

export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function relativeWorkspacePath(
  folder: vscode.WorkspaceFolder,
  uri: vscode.Uri
): string | undefined {
  if (uri.scheme !== 'file' || folder.uri.scheme !== 'file') {
    return undefined;
  }
  const owningFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!owningFolder || owningFolder.uri.toString() !== folder.uri.toString()) {
    return undefined;
  }
  const relative = vscode.workspace.asRelativePath(uri, false);
  return relative.startsWith('..') ? undefined : relative.replaceAll('\\', '/');
}

export function diagnosticSeverity(
  diagnostics: readonly vscode.Diagnostic[]
): 'error' | 'warning' | 'info' | 'hint' | 'mixed' {
  const severities = new Set(diagnostics.map((item) => item.severity));
  if (severities.size > 1) {
    return 'mixed';
  }
  const only = diagnostics[0]?.severity;
  if (only === vscode.DiagnosticSeverity.Error) {
    return 'error';
  }
  if (only === vscode.DiagnosticSeverity.Warning) {
    return 'warning';
  }
  if (only === vscode.DiagnosticSeverity.Information) {
    return 'info';
  }
  return 'hint';
}

export async function captureActiveFile(
  controller: SessionController
): Promise<PendingContextItem | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  return captureFileLike(controller, editor.document, 'activeFile');
}

export async function capturePickedFile(
  controller: SessionController
): Promise<PendingContextItem | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Attach',
    title: 'Add a file to the chat',
    defaultUri: controller.folder.uri,
  });
  const uri = picked?.[0];
  if (!uri) {
    return undefined;
  }
  // Containment check first — cheap, avoids any read for out-of-workspace files.
  const workspaceRelativePath = relativeWorkspacePath(controller.folder, uri);
  if (!workspaceRelativePath) {
    void vscode.window.showWarningMessage(
      'Only files inside the active workspace can be attached.'
    );
    return undefined;
  }
  // Size guard BEFORE reading, so a huge/binary file cannot freeze the UI.
  const MAX_ATTACH_BYTES = 512 * 1024;
  let size = 0;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      void vscode.window.showWarningMessage('Pick a file, not a folder.');
      return undefined;
    }
    size = stat.size;
  } catch {
    void vscode.window.showWarningMessage('Could not read that file.');
    return undefined;
  }
  if (size > MAX_ATTACH_BYTES) {
    void vscode.window.showWarningMessage(
      `That file is too large to attach (${Math.round(size / 1024)} KB > ${
        MAX_ATTACH_BYTES / 1024
      } KB). Attach a smaller file or a selection.`
    );
    return undefined;
  }
  // Read bytes directly (fast) instead of opening a full TextDocument, which
  // makes VS Code tokenize/language-process the whole file.
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    void vscode.window.showWarningMessage('Could not read that file.');
    return undefined;
  }
  const content = boundFileContent(text);
  const lineEnd = content.split('\n').length;
  const languageId = basename(uri.fsPath).split('.').pop() || 'plaintext';
  return {
    kind: 'pickedFile',
    itemId: makeId('pickedFile'),
    workspaceFolder: controller.folder.uri.fsPath,
    workspaceRelativePath,
    lineStart: 1,
    lineEnd,
    languageId,
    sanitizedContent: content,
    capturedAt: new Date().toISOString(),
    persistedRef: {
      workspaceRelativePath,
      lineStart: 1,
      lineEnd,
      languageId,
      contentFingerprint: fingerprint(content),
    },
  };
}

export async function captureFileLike(
  controller: SessionController,
  document: vscode.TextDocument,
  kind: 'activeFile' | 'pickedFile'
): Promise<PendingContextItem | undefined> {
  const workspaceRelativePath = relativeWorkspacePath(controller.folder, document.uri);
  if (!workspaceRelativePath) {
    void vscode.window.showWarningMessage(
      'Only files inside the active workspace can be attached.'
    );
    return undefined;
  }
  const content = boundFileContent(document.getText());
  const lineEnd = Math.min(document.lineCount, content.split('\n').length);
  return {
    kind,
    itemId: makeId(kind),
    workspaceFolder: controller.folder.uri.fsPath,
    workspaceRelativePath,
    lineStart: 1,
    lineEnd,
    languageId: document.languageId,
    sanitizedContent: content,
    capturedAt: new Date().toISOString(),
    persistedRef: {
      workspaceRelativePath,
      lineStart: 1,
      lineEnd,
      languageId: document.languageId,
      contentFingerprint: fingerprint(content),
    },
  };
}

export async function captureSelection(
  controller: SessionController
): Promise<PendingContextItem | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const workspaceRelativePath = relativeWorkspacePath(controller.folder, editor.document.uri);
  if (!workspaceRelativePath) {
    void vscode.window.showWarningMessage(
      'Only selections inside the active workspace can be attached.'
    );
    return undefined;
  }
  const content = boundFileContent(editor.document.getText(editor.selection));
  const lineStart = editor.selection.start.line + 1;
  const lineEnd = editor.selection.end.line + 1;
  return {
    kind: 'selection',
    itemId: makeId('selection'),
    workspaceFolder: controller.folder.uri.fsPath,
    workspaceRelativePath,
    lineStart,
    lineEnd,
    languageId: editor.document.languageId,
    sanitizedContent: content,
    capturedAt: new Date().toISOString(),
    persistedRef: {
      workspaceRelativePath,
      lineStart,
      lineEnd,
      languageId: editor.document.languageId,
      contentFingerprint: fingerprint(content),
    },
  };
}

export async function captureDiagnostics(
  controller: SessionController
): Promise<PendingContextItem | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const workspaceRelativePath = relativeWorkspacePath(controller.folder, editor.document.uri);
  if (!workspaceRelativePath) {
    void vscode.window.showWarningMessage(
      'Only diagnostics inside the active workspace can be attached.'
    );
    return undefined;
  }
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
  const lineStart =
    diagnostics.length > 0
      ? Math.min(...diagnostics.map((item) => item.range.start.line + 1))
      : 1;
  const lineEnd =
    diagnostics.length > 0 ? Math.max(...diagnostics.map((item) => item.range.end.line + 1)) : 1;
  const severity = diagnosticSeverity(diagnostics);
  const content = boundDiagnosticsContent(
    diagnostics.length === 0
      ? 'INFO L1: No diagnostics.'
      : diagnostics
          .slice(0, 100)
          .map((item) => {
            const level =
              item.severity === vscode.DiagnosticSeverity.Error
                ? 'ERROR'
                : item.severity === vscode.DiagnosticSeverity.Warning
                  ? 'WARNING'
                  : item.severity === vscode.DiagnosticSeverity.Information
                    ? 'INFO'
                    : 'HINT';
            return `${level} L${item.range.start.line + 1}: ${item.message}`;
          })
          .join('\n')
  );
  return {
    kind: 'diagnostics',
    itemId: makeId('diagnostics'),
    workspaceFolder: controller.folder.uri.fsPath,
    workspaceRelativePath,
    lineStart,
    lineEnd,
    severity,
    issueCount: diagnostics.length,
    sanitizedContent: content,
    capturedAt: new Date().toISOString(),
    persistedRef: {
      workspaceRelativePath,
      lineStart,
      lineEnd,
      severity,
      issueCount: diagnostics.length,
      diagnosticFingerprint: fingerprint(content),
    },
  };
}
