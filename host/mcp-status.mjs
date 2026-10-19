// Native /mcp is read-only with empty arguments in RPC mode. Its UI stays request-local.
export function nativeMcpCommand(session) {
  const runner = session.extensionRunner;
  if (
    typeof runner?.getRegisteredCommands !== 'function' ||
    typeof runner.createCommandContext !== 'function'
  )
    return undefined;
  const matches = runner
    .getRegisteredCommands()
    .filter(
      (command) =>
        command.name === 'mcp' &&
        command.invocationName === 'mcp' &&
        command.sourceInfo?.source === 'builtin' &&
        command.sourceInfo?.path === 'builtin:mcp' &&
        typeof command.handler === 'function'
    );
  return matches.length === 1 ? matches[0] : undefined;
}

export function redactMcpStatus(value) {
  const raw = String(value);
  const bounded =
    raw.length > 24000
      ? raw.slice(0, 24000).replace(/[^\n]*$/, '[Additional detail omitted]')
      : raw;
  return bounded
    .split('\n')
    .map((line) =>
      /(?:authorization|cookie|password|secret|api[_-]?key|(?:access|refresh)[_-]?token)\b|\btoken\b\s*[:=]/i.test(
        line
      )
        ? `${/^\s/.test(line) ? '    ' : ''}[Credential detail omitted]`
        : line
    )
    .join('\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/https?:\/\/[^\s<>]+/gi, '[URL omitted]')
    .replace(/\b(?:(?:Bearer|Basic)\s+\S+|sk-[A-Za-z0-9_-]{10,})/gi, '[REDACTED]')
    .replace(
      /(["']?(?:password|secret|token|api[_-]?key|client[_-]?secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/(?:[A-Za-z]:)?[\\/]Users[\\/][^\\/\s]+|\/home\/[^/\s]+/g, '[HOME]');
}

export async function readNativeMcpStatus(session, valid) {
  const command = nativeMcpCommand(session);
  if (!command) return { contract: 1, status: 'unsupported', notifications: [] };
  const original = session.extensionRunner.createCommandContext();
  if (original.mode !== 'rpc') return { contract: 1, status: 'unsupported', notifications: [] };
  const descriptors = Object.getOwnPropertyDescriptors(original);
  delete descriptors.ui;
  const context = Object.create(Object.getPrototypeOf(original), descriptors);
  const ui = Object.getOwnPropertyDescriptors(original.ui);
  delete ui.notify;
  const notifications = [];
  let active = true;
  Object.defineProperty(context, 'ui', {
    value: Object.create(Object.getPrototypeOf(original.ui), {
      ...ui,
      notify: {
        value(message, level) {
          if (active && valid() && notifications.length < 4 && typeof message === 'string')
            notifications.push({
              message: redactMcpStatus(message),
              level: ['info', 'warning', 'error'].includes(level) ? level : 'info',
            });
        },
      },
    }),
  });
  let timer;
  try {
    if (!valid()) throw new Error('MCP_STATUS_STALE_ORIGIN');
    const completed = await Promise.race([
      Promise.resolve()
        .then(() => command.handler('', context))
        .then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
    if (!valid()) throw new Error('MCP_STATUS_STALE_ORIGIN');
    if (!completed || notifications.length !== 1)
      return {
        contract: 1,
        status: 'unavailable',
        notifications: [],
        reason: completed ? 'malformed' : 'timeout',
      };
    return {
      contract: 1,
      status: 'checked',
      checkedAt: Date.now(),
      notifications: notifications.map((item) => ({ ...item })),
    };
  } catch (error) {
    if (error?.message === 'MCP_STATUS_STALE_ORIGIN') throw error;
    return { contract: 1, status: 'unavailable', notifications: [], reason: 'request-failed' };
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
