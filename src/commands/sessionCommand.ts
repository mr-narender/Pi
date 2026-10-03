import * as vscode from 'vscode';
import type { SessionController } from '../sessions/sessionController';
import { projectSessionInfo } from '../sessions/sessionInfo';
import { beginReadOnlyCommand } from './readOnlyCommand';

/** Native VS Code viewer/clipboard shared by menu and composer, captured origin only. */
export async function sessionCommand(
  controller: SessionController,
  args: string,
  valid: () => boolean
): Promise<boolean> {
  if (args) throw new Error('/session does not accept arguments.');
  const stats = projectSessionInfo(await controller.showSessionStats());
  if (!valid()) throw new Error('The originating chat changed; session info cancelled.');
  const tokens = stats.tokens as Record<string, unknown>;
  const context = stats.contextUsage as Record<string, unknown>;
  const text = (value: unknown) =>
    value === undefined || value === null ? 'unknown' : String(value);
  const lines = [
    `Name: ${text(stats.sessionName)}`,
    `File: ${typeof stats.sessionFile === 'string' ? stats.sessionFile : 'In-memory'}`,
    `ID: ${text(stats.sessionId)}`,
    'All branches (including compacted history):',
    `Entries: ${text(stats.totalEntries)}`,
    `Messages: ${text(stats.totalMessages)} total · ${text(stats.userMessages)} user · ${text(stats.assistantMessages)} assistant`,
    `Tools: ${text(stats.toolCalls)} calls · ${text(stats.toolResults)} results`,
    `Tokens: ${text(tokens.total)} total · input ${text(tokens.input)} · output ${text(tokens.output)}`,
    `Cache: ${text(tokens.cacheRead)} read · ${text(tokens.cacheWrite)} write tokens`,
    `Reported cost: ${typeof stats.cost === 'number' ? '$' + stats.cost.toFixed(4) : 'unknown'}`,
    `Active context: ${text(context.tokens)} / ${text(context.contextWindow)} tokens (${text(context.percent)}%)`,
  ];
  const choice = await vscode.window.showInformationMessage(
    'Session Info',
    { modal: true, detail: lines.join('\n') },
    'Done',
    'Copy JSON'
  );
  if (!valid()) throw new Error('The originating chat changed; session info cancelled.');
  if (choice === 'Done') return valid();
  if (choice !== 'Copy JSON') return false;
  await vscode.env.clipboard.writeText(JSON.stringify(stats, null, 2));
  return valid();
}

export async function showChatSession(controller: SessionController): Promise<boolean> {
  const intent = beginReadOnlyCommand(controller);
  await intent.ready();
  return sessionCommand(controller, '', intent.valid);
}
