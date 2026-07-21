import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { redactText } from '../diagnostics/redaction';

const SESSION_ENV_DIR = 'PI_CODING_AGENT_SESSION_DIR';
const AGENT_ENV_DIR = 'PI_CODING_AGENT_DIR';
const DEFAULT_AGENT_DIR = '.pi/agent';
const MAX_TITLE_CHARS = 72;
const MAX_PROMPT_CHARS = 96;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const UNKNOWN_RELATIVE_TIMESTAMP = 'Unknown';

export interface SessionWorkspaceContext {
  workspaceName: string;
  workspacePath: string;
  additionalArgs?: string[];
}

export interface RecentSessionRecord {
  path: string;
  id: string;
  cwd: string;
  workspaceLabel: string;
  sessionName?: string;
  firstPromptPreview?: string;
  displayName: string;
  modelLabel?: string;
  messageCount: number;
  modifiedAt: number;
  createdAt: number;
  parentSessionPath?: string;
}

export interface RecentSessionsIndex {
  sessionDir: string;
  filterByWorkspaceCwd: boolean;
  sessions: RecentSessionRecord[];
}

function sanitizeInlineText(value: string, limit: number): string {
  const compact = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  if (/^data:/i.test(compact)) {
    return '[data omitted]';
  }
  const collapsed = compact.replace(/\s+/g, '');
  if (
    collapsed.length >= 32 &&
    collapsed.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+=*$/.test(collapsed)
  ) {
    return '[encoded text omitted]';
  }
  const redacted = redactText(compact);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      const typed = block as Record<string, unknown>;
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(Boolean)
    .join(' ');
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getAgentDir(): string {
  return process.env[AGENT_ENV_DIR]
    ? resolve(process.env[AGENT_ENV_DIR])
    : join(homedir(), DEFAULT_AGENT_DIR);
}

export function getDefaultSessionDirForWorkspace(
  workspacePath: string,
  agentDir = getAgentDir()
): string {
  const resolvedWorkspace = resolve(workspacePath);
  const safePath = `--${resolvedWorkspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(resolve(agentDir), 'sessions', safePath);
}

function parseSessionDirFromArgs(additionalArgs: string[] | undefined): string | undefined {
  if (!additionalArgs) {
    return undefined;
  }
  for (let index = 0; index < additionalArgs.length; index += 1) {
    const value = additionalArgs[index];
    if (!value) {
      continue;
    }
    if (value === '--session-dir') {
      const next = additionalArgs[index + 1];
      return typeof next === 'string' && next.length > 0 ? resolve(next) : undefined;
    }
    if (value.startsWith('--session-dir=')) {
      return resolve(value.slice('--session-dir='.length));
    }
  }
  return undefined;
}

async function readSessionDirFromSettingsFile(path: string): Promise<string | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.sessionDir === 'string' && parsed.sessionDir.trim().length > 0
      ? resolve(parsed.sessionDir)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveSessionDir(
  context: SessionWorkspaceContext
): Promise<{ sessionDir: string; filterByWorkspaceCwd: boolean }> {
  const defaultDir = getDefaultSessionDirForWorkspace(context.workspacePath);
  const fromArgs = parseSessionDirFromArgs(context.additionalArgs);
  if (fromArgs) {
    return {
      sessionDir: fromArgs,
      filterByWorkspaceCwd: resolve(fromArgs) !== resolve(defaultDir),
    };
  }
  const fromEnv = process.env[SESSION_ENV_DIR];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    const resolved = resolve(fromEnv);
    return {
      sessionDir: resolved,
      filterByWorkspaceCwd: resolved !== resolve(defaultDir),
    };
  }
  const workspaceSettings = await readSessionDirFromSettingsFile(
    join(context.workspacePath, '.pi', 'settings.json')
  );
  if (workspaceSettings) {
    return {
      sessionDir: workspaceSettings,
      filterByWorkspaceCwd: resolve(workspaceSettings) !== resolve(defaultDir),
    };
  }
  const globalSettings = await readSessionDirFromSettingsFile(join(getAgentDir(), 'settings.json'));
  if (globalSettings) {
    return {
      sessionDir: globalSettings,
      filterByWorkspaceCwd: resolve(globalSettings) !== resolve(defaultDir),
    };
  }
  return { sessionDir: defaultDir, filterByWorkspaceCwd: false };
}

function isPlausibleTimestamp(value: number, now: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_TIMESTAMP_MS &&
    value <= now + MAX_FUTURE_SKEW_MS
  );
}

function parseTimestamp(value: unknown, now: number): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Date.parse(value)
        : Number.NaN;
  return isPlausibleTimestamp(parsed, now) ? parsed : undefined;
}

function getMessageActivityTime(entry: Record<string, unknown>, now: number): number | undefined {
  const message = asObject(entry.message);
  if (!message) {
    return undefined;
  }
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') {
    return undefined;
  }
  return parseTimestamp(message.timestamp, now) ?? parseTimestamp(entry.timestamp, now);
}

function compareRecentSessionRecordTimestamps(
  left: RecentSessionRecord,
  right: RecentSessionRecord
): number {
  const leftKnown = left.modifiedAt > 0 && Number.isFinite(left.modifiedAt);
  const rightKnown = right.modifiedAt > 0 && Number.isFinite(right.modifiedAt);
  if (leftKnown && rightKnown) {
    return right.modifiedAt - left.modifiedAt;
  }
  if (leftKnown) {
    return -1;
  }
  if (rightKnown) {
    return 1;
  }
  return 0;
}

async function buildRecentSessionRecord(
  filePath: string,
  now: number
): Promise<RecentSessionRecord | undefined> {
  try {
    const stats = await stat(filePath).catch(() => undefined);
    let header: Record<string, unknown> | undefined;
    let sessionName: string | undefined;
    let firstPromptPreview: string | undefined;
    let modelLabel: string | undefined;
    let messageCount = 0;
    let lastActivityTime: number | undefined;

    const reader = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const record = asObject(entry);
      if (!record) {
        continue;
      }
      if (!header) {
        if (record.type !== 'session' || typeof record.id !== 'string') {
          return undefined;
        }
        header = record;
        continue;
      }
      if (record.type === 'session_info') {
        sessionName =
          typeof record.name === 'string' && record.name.trim().length > 0
            ? sanitizeInlineText(record.name, MAX_TITLE_CHARS)
            : undefined;
      }
      if (record.type === 'model_change') {
        if (typeof record.provider === 'string' && typeof record.modelId === 'string') {
          modelLabel = sanitizeInlineText(`${record.provider}/${record.modelId}`, MAX_TITLE_CHARS);
        }
      }
      if (record.type !== 'message') {
        continue;
      }
      messageCount += 1;
      const activityTime = getMessageActivityTime(record, now);
      if (activityTime !== undefined) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
      }
      const message = asObject(record.message);
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
        continue;
      }
      if (
        typeof message.role === 'string' &&
        message.role === 'assistant' &&
        typeof message.provider === 'string' &&
        typeof message.model === 'string'
      ) {
        modelLabel = sanitizeInlineText(`${message.provider}/${message.model}`, MAX_TITLE_CHARS);
      }
      const textContent = sanitizeInlineText(extractTextContent(message.content), MAX_PROMPT_CHARS);
      if (message.role === 'user' && !firstPromptPreview && textContent) {
        firstPromptPreview = textContent;
      }
    }

    if (!header) {
      return undefined;
    }

    const cwd = typeof header.cwd === 'string' ? resolve(header.cwd) : '';
    const filesystemTimestamp = parseTimestamp(stats?.mtimeMs, now);
    const createdAt = parseTimestamp(header.timestamp, now) ?? filesystemTimestamp ?? 0;
    const modifiedAt = Math.max(lastActivityTime ?? 0, filesystemTimestamp ?? 0, createdAt);
    const displayName =
      sessionName ??
      firstPromptPreview ??
      sanitizeInlineText(`Session ${String(header.id)}`, MAX_TITLE_CHARS);

    return {
      path: resolve(filePath),
      id: String(header.id),
      cwd,
      workspaceLabel: sanitizeInlineText(
        basename(cwd) || cwd || 'Unknown workspace',
        MAX_TITLE_CHARS
      ),
      sessionName,
      firstPromptPreview,
      displayName,
      modelLabel,
      messageCount,
      modifiedAt,
      createdAt,
      parentSessionPath:
        typeof header.parentSession === 'string' ? resolve(header.parentSession) : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Normalize a working-directory path for comparison: resolve it, follow
 * symlinks when the path exists (handles macOS `/var` -> `/private/var`), and
 * drop any trailing separators. Best-effort — never throws.
 */
export function normalizeWorkspaceCwd(value: string): string {
  let normalized = resolve(value);
  try {
    normalized = realpathSync.native(normalized);
  } catch {
    // Path may not exist (deleted worktree); fall back to the resolved form.
  }
  return normalized.replace(/[/\\]+$/, '');
}

/**
 * Whether a session's recorded cwd belongs to the given workspace. Tolerant of
 * trailing-slash and symlink-normalization drift so history is not silently
 * dropped. A session with no recorded cwd is treated as belonging (lenient).
 */
export function sameWorkspaceCwd(sessionCwd: string | undefined, workspacePath: string): boolean {
  if (!sessionCwd || sessionCwd.trim().length === 0) {
    return true;
  }
  return normalizeWorkspaceCwd(sessionCwd) === normalizeWorkspaceCwd(workspacePath);
}

export async function readRecentSessionsIndex(
  context: SessionWorkspaceContext
): Promise<RecentSessionsIndex> {
  const resolvedWorkspacePath = resolve(context.workspacePath);
  const { sessionDir, filterByWorkspaceCwd } = await resolveSessionDir(context);
  if (!existsSync(sessionDir)) {
    return { sessionDir, filterByWorkspaceCwd, sessions: [] };
  }

  const entries = await readdir(sessionDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(sessionDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const now = Date.now();

  const sessions = (
    await Promise.all(
      files.map(async (file, index) => ({
        index,
        session: await buildRecentSessionRecord(file, now),
      }))
    )
  )
    .filter((item): item is { index: number; session: RecentSessionRecord } => {
      if (!item.session) {
        return false;
      }
      return !filterByWorkspaceCwd || sameWorkspaceCwd(item.session.cwd, resolvedWorkspacePath);
    })
    .sort(
      (left, right) =>
        compareRecentSessionRecordTimestamps(left.session, right.session) ||
        left.index - right.index
    )
    .map((item) => item.session);
  return { sessionDir, filterByWorkspaceCwd, sessions };
}

export function filterRecentSessions(
  sessions: RecentSessionRecord[],
  filterText: string
): RecentSessionRecord[] {
  const query = filterText.trim().toLowerCase();
  if (!query) {
    return sessions;
  }
  return sessions.filter((session) =>
    [
      session.displayName,
      session.sessionName,
      session.firstPromptPreview,
      session.workspaceLabel,
      session.modelLabel,
      session.id,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .some((value) => value.toLowerCase().includes(query))
  );
}

export function formatRelativeTimestamp(value: number, now = Date.now()): string {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(now)) {
    return UNKNOWN_RELATIVE_TIMESTAMP;
  }
  const delta = Math.max(0, now - value);
  if (!Number.isFinite(delta)) {
    return UNKNOWN_RELATIVE_TIMESTAMP;
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) {
    return 'just now';
  }
  if (delta < hour) {
    return `${Math.floor(delta / minute)}m ago`;
  }
  if (delta < day) {
    return `${Math.floor(delta / hour)}h ago`;
  }
  return `${Math.floor(delta / day)}d ago`;
}
