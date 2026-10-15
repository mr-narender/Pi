import { isAbsolute, relative, resolve, sep } from 'node:path';
import { redactText } from '../diagnostics/redaction';
import { toolActivity } from '../live/toolActivity';
import type { ControllerState, WebviewActivity, WebviewMessageItem } from '../state/types';
import type { JsonObject } from '../rpc/protocol';

function displayText(value: string, limit: number): string {
  const plain = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const redacted = redactText(
    plain.replace(/data:[^\s]+|[A-Za-z0-9+/]{128,}={0,2}/g, '[encoded data omitted]')
  );
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function outputText(result: JsonObject | undefined): string {
  const content = result?.content;
  if (typeof content === 'string') return displayText(content, 4000);
  if (!Array.isArray(content)) return '';
  // Only the bounded text preview crosses the remote webview bridge.
  let text = '';
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      !Array.isArray(block) &&
      block.type === 'text' &&
      typeof block.text === 'string'
    ) {
      text += `${text ? '\n' : ''}${displayText(block.text, 4000)}`;
      if (text.length > 4000) break;
    }
  }
  return displayText(text, 4000);
}

export function projectActivity(
  state: ControllerState,
  messages: WebviewMessageItem[]
): WebviewActivity {
  const files = new Set<string>();
  const addFile = (path: string) => {
    if (
      files.size >= 30 ||
      !path ||
      path.length > 1000 ||
      (!isAbsolute(path) && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path))
    )
      return;
    const local = relative(state.cwd, resolve(state.cwd, path));
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return;
    files.add(local.split(sep).join('/'));
  };
  for (const tool of state.tools.slice(-30)) {
    const paths = Object.fromEntries(
      ['path', 'file_path', 'filePath', 'file', 'target_file'].map((key) => [
        key,
        typeof tool.args?.[key] === 'string' ? tool.args[key] : undefined,
      ])
    );
    const activity = toolActivity(tool.name, JSON.stringify(paths));
    if (activity) addFile(activity.path);
  }
  for (const message of messages) {
    for (const context of message.capturedContext ?? [])
      if (context.fileRef) addFile(context.fileRef.path);
    for (const attachment of message.attachments)
      if (attachment.fileRef) addFile(attachment.fileRef.path);
  }
  const tools = state.tools.slice(-8).map((tool) => ({
    id: displayText(tool.id, 120),
    name: displayText(tool.name, 80),
    status: tool.isError
      ? ('error' as const)
      : tool.endedAt === undefined
        ? ('running' as const)
        : ('completed' as const),
    ...(typeof tool.durationMs === 'number' &&
    Number.isFinite(tool.durationMs) &&
    tool.durationMs >= 0
      ? { durationMs: tool.durationMs }
      : {}),
  }));
  const latest = state.tools.at(-1);
  const statuses = Object.entries(state.statuses)
    .slice(0, 8)
    .map(([label, text]) => ({ label: displayText(label, 80), text: displayText(text, 240) }));
  for (const widget of state.widgets.slice(0, Math.max(0, 8 - statuses.length))) {
    statuses.push({
      label: displayText(widget.key, 80),
      text: displayText(widget.lines.slice(0, 4).join('\n'), 240),
    });
  }
  return {
    tools,
    output: outputText(latest?.result ?? latest?.partialResult),
    files: [...files].map((path) => ({ path })),
    statuses,
  };
}
