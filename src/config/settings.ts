import * as vscode from 'vscode';

export interface PiRpcSettings {
  executable: string;
  additionalArgs: string[];
  offline: boolean;
  allowApproveInTrustedWorkspace: boolean;
  responseTimeoutMs: number;
  longRunningTimeoutMs: number;
  maxRecordBytes: number;
  maxPendingRequests: number;
  maxQueuedWrites: number;
  maxTranscriptItems: number;
  messageWindowSize: number;
  maxToolOutputChars: number;
  maxImageBytes: number;
  maxImagesPerPrompt: number;
  restartOnCrash: boolean;
  maxRestartAttempts: number;
  telemetryEnabled: boolean;
  autoStart: boolean;
  editorTabsEnabled: boolean;
  workingAnimation: string;
  chatFontFamily: string;
  chatFontSize: number;
  notifyOnComplete: boolean;
  typewriterSpeed: string;
  autoCompactThreshold: number;
  autoCompactMode: 'auto' | 'off';
  autoCompactPercent: number;
  autoCompactResumeTask: boolean;
  codeLensEnabled: boolean;
  remoteEnabled: boolean;
}

export function getSettings(): PiRpcSettings {
  const config = vscode.workspace.getConfiguration('piRpc');
  return {
    executable: config.get<string>('executable', 'pi'),
    additionalArgs: config.get<string[]>('additionalArgs', []),
    // Online by default, like the Pi TUI. Running --offline broke sessions whose
    // extensions need the network at startup. Set true only to force offline.
    offline: config.get<boolean>('offline', false),
    allowApproveInTrustedWorkspace: config.get<boolean>('allowApproveInTrustedWorkspace', false),
    // Phone/remote-session feature is opt-in. When false the Connect a phone
    // button and the Start/Stop Remote Session commands are hidden.
    remoteEnabled: config.get<boolean>('remote.enabled', false),
    responseTimeoutMs: config.get<number>('responseTimeoutMs', 15000),
    longRunningTimeoutMs: config.get<number>('longRunningTimeoutMs', 120000),
    // Session replay can contain one large JSONL record (for example an
    // embedded image or a large tool result). Keep a bounded but practical
    // default; users can lower this explicitly if required.
    maxRecordBytes: config.get<number>('maxRecordBytes', 64 * 1024 * 1024),
    maxPendingRequests: config.get<number>('maxPendingRequests', 256),
    maxQueuedWrites: config.get<number>('maxQueuedWrites', 256),
    maxTranscriptItems: config.get<number>('maxTranscriptItems', 400),
    messageWindowSize: config.get<number>('messageWindowSize', 50),
    maxToolOutputChars: config.get<number>('maxToolOutputChars', 20000),
    maxImageBytes: config.get<number>('maxImageBytes', 3145728),
    maxImagesPerPrompt: config.get<number>('maxImagesPerPrompt', 4),
    workingAnimation: config.get<string>('workingAnimation', 'braille'),
    chatFontFamily: config.get<string>('chatFontFamily', ''),
    chatFontSize: config.get<number>('chatFontSize', 0),
    notifyOnComplete: config.get<boolean>('notifyOnComplete', true),
    typewriterSpeed: config.get<string>('typewriterSpeed', 'normal'),
    autoCompactThreshold: config.get<number>('autoCompactThreshold', 70),
    // 'auto' = detect the current model's max context and compact at
    // autoCompact.percent of it; 'off' = never auto-compact (Pi still
    // compacts when nearly full).
    autoCompactMode: config.get<'auto' | 'off'>('autoCompact.mode', 'auto'),
    autoCompactPercent: config.get<number>('autoCompact.percent', 65),
    autoCompactResumeTask: config.get<boolean>('autoCompact.resumeTask', true),
    codeLensEnabled: config.get<boolean>('codeLensEnabled', true),
    restartOnCrash: config.get<boolean>('restartOnCrash', true),
    maxRestartAttempts: config.get<number>('maxRestartAttempts', 3),
    telemetryEnabled: config.get<boolean>('telemetryEnabled', false),
    autoStart: config.get<boolean>('autoStart', false),
    editorTabsEnabled: config.get<boolean>('editorTabs.enabled', true),
  };
}

export function validateAdditionalArgs(args: string[]): void {
  if (args.some((arg) => arg === '--api-key' || arg.startsWith('--api-key='))) {
    throw new Error(
      'Persisted --api-key is forbidden. Use Pi authentication or environment variables.'
    );
  }
}
