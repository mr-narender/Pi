const fail = () => {
  throw new Error('IMPORT_INVALID_SESSION');
};
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' && !v.includes('\0');
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const stamp = (v) =>
  string(v) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
const optional = (v, check) => v === undefined || check(v);
const keys = (v, allowed) => Object.keys(v).every((k) => allowed.includes(k));
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function usage(v) {
  return (
    object(v) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every((k) => number(v[k])) &&
    optional(v.reasoning, number) &&
    optional(v.cacheWrite1h, number) &&
    object(v.cost) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every((k) => number(v.cost[k]))
  );
}
function content(v, allowed, textAllowed = true) {
  if (textAllowed && string(v)) return true;
  return (
    Array.isArray(v) &&
    v.every(
      (b) =>
        object(b) &&
        allowed.includes(b.type) &&
        (b.type === 'text'
          ? string(b.text) && optional(b.textSignature, string)
          : b.type === 'image'
            ? string(b.data) && string(b.mimeType) && /^image\//.test(b.mimeType)
            : b.type === 'thinking'
              ? string(b.thinking) &&
                optional(b.thinkingSignature, string) &&
                optional(b.redacted, (v) => typeof v === 'boolean')
              : b.type === 'toolCall'
                ? string(b.id) && string(b.name) && object(b.arguments)
                : false)
    )
  );
}
const boolean = (v) => typeof v === 'boolean';
function deferred(v) {
  return (
    object(v) &&
    ['provider', 'modelId', 'api', 'id'].every((k) => string(v[k])) &&
    optional(v.expiresAt, number) &&
    optional(v.pollAfterMs, number)
  );
}
function diagnostics(v) {
  return (
    Array.isArray(v) &&
    v.every(
      (d) =>
        object(d) &&
        string(d.type) &&
        number(d.timestamp) &&
        optional(d.details, object) &&
        optional(
          d.error,
          (e) =>
            object(e) &&
            string(e.message) &&
            optional(e.name, string) &&
            optional(e.stack, string) &&
            optional(e.code, (c) => string(c) || Number.isFinite(c))
        )
    )
  );
}
function nested(v) {
  return (
    object(v) &&
    boolean(v.complete) &&
    Array.isArray(v.calls) &&
    v.calls.every(
      (c) =>
        object(c) &&
        string(c.id) &&
        string(c.name) &&
        ['ok', 'error', 'unfinished'].includes(c.status) &&
        optional(c.arguments, object) &&
        optional(c.argumentsBytes, number) &&
        optional(c.durationMs, number) &&
        optional(c.error, string)
    )
  );
}
function message(m, version) {
  if (!object(m) || !number(m.timestamp)) return false;
  switch (m.role) {
    case 'user':
      return content(m.content, ['text', 'image']);
    case 'system':
      return (
        content(m.content, ['text']) &&
        optional(
          m.sections,
          (v) => object(v) && Object.values(v).every((s) => s === null || string(s))
        ) &&
        optional(
          m.toolsAdded,
          (v) =>
            Array.isArray(v) &&
            v.every(
              (t) => object(t) && string(t.name) && string(t.description) && object(t.parameters)
            )
        ) &&
        optional(
          m.toolsRemoved,
          (v) => Array.isArray(v) && v.every((t) => object(t) && string(t.name))
        )
      );
    case 'assistant':
      return (
        content(m.content, ['text', 'thinking', 'toolCall'], false) &&
        ['api', 'provider', 'model'].every((k) => string(m[k])) &&
        usage(m.usage) &&
        ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(
          m.stopReason
        ) &&
        optional(m.thinkingLevel, (v) => levels.includes(v)) &&
        [
          'responseModel',
          'responseId',
          'providerThinkingLevel',
          'errorMessage',
          'rawStopReason',
        ].every((k) => optional(m[k], string)) &&
        optional(m.endTurn, boolean) &&
        optional(m.deferred, deferred) &&
        optional(m.diagnostics, diagnostics)
      );
    case 'toolResult':
      return (
        string(m.toolCallId) &&
        string(m.toolName) &&
        content(m.content, ['text', 'image'], false) &&
        typeof m.isError === 'boolean' &&
        optional(m.usage, usage) &&
        optional(m.nestedCalls, nested)
      );
    case 'hookMessage':
      if (version >= 3) return false; // legacy native migration to custom
    // falls through
    case 'custom':
      return (
        string(m.customType) &&
        content(m.content, ['text', 'image']) &&
        typeof m.display === 'boolean'
      );
    case 'bashExecution':
      return (
        string(m.command) &&
        string(m.output) &&
        typeof m.cancelled === 'boolean' &&
        typeof m.truncated === 'boolean' &&
        optional(m.exitCode, (v) => Number.isInteger(v)) &&
        optional(m.fullOutputPath, string) &&
        optional(m.excludeFromContext, (v) => typeof v === 'boolean')
      );
    default:
      return false;
  }
}
/** Strict bounded parser BEFORE native's permissive parser/copy. Does not alter input bytes. */
export function validateImport(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 8 * 1024 * 1024) fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) fail();
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > 20000 || lines.some((l) => !l.trim() || Buffer.byteLength(l) > 1024 * 1024))
    fail();
  let rows;
  try {
    rows = lines.map((l) => JSON.parse(l));
  } catch {
    fail();
  }
  const pending = rows.map((value) => ({ value, depth: 0 }));
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > 400000 || depth > 64) fail();
    if (value && typeof value === 'object')
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  const h = rows[0],
    version = h?.version === undefined ? 1 : h.version;
  if (
    !object(h) ||
    h.type !== 'session' ||
    ![1, 2, 3].includes(version) ||
    !string(h.id) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(h.id) ||
    !stamp(h.timestamp) ||
    !string(h.cwd) ||
    !optional(h.parentSession, string) ||
    !keys(h, ['type', 'version', 'id', 'timestamp', 'cwd', 'parentSession'])
  )
    fail();
  const entries = rows.slice(1),
    byId = new Map();
  for (const e of entries) {
    if (!object(e) || !stamp(e.timestamp)) fail();
    if (version >= 2) {
      if (
        !string(e.id) ||
        !e.id ||
        byId.has(e.id) ||
        !(e.parentId === null || (string(e.parentId) && e.parentId))
      )
        fail();
      byId.set(e.id, e);
    }
    let valid = false;
    switch (e.type) {
      case 'message':
        valid = message(e.message, version);
        break;
      case 'thinking_level_change':
        valid = levels.includes(e.thinkingLevel);
        break;
      case 'model_change':
        valid = string(e.provider) && string(e.modelId);
        break;
      case 'usage':
        valid =
          string(e.kind) &&
          string(e.provider) &&
          string(e.model) &&
          usage(e.usage) &&
          optional(e.note, string);
        break;
      case 'compaction':
        valid =
          string(e.summary) &&
          number(e.tokensBefore) &&
          (version === 1
            ? Number.isInteger(e.firstKeptEntryIndex) &&
              e.firstKeptEntryIndex > 0 &&
              e.firstKeptEntryIndex < rows.indexOf(e)
            : string(e.firstKeptEntryId)) &&
          optional(e.usage, usage) &&
          optional(e.systemMessage, (m) => message(m, version) && m.role === 'system');
        break;
      case 'branch_summary':
        valid = string(e.summary) && string(e.fromId) && optional(e.usage, usage);
        break;
      case 'custom':
        valid = string(e.customType);
        break;
      case 'custom_message':
        valid =
          string(e.customType) &&
          content(e.content, ['text', 'image']) &&
          typeof e.display === 'boolean';
        break;
      case 'context_edit':
        valid =
          version === 3 &&
          string(e.targetId) &&
          (e.replacement === null ||
            (object(e.replacement) &&
              content(e.replacement.content, ['text', 'image', 'thinking', 'toolCall'])));
        break;
      case 'label':
        valid = string(e.targetId) && optional(e.label, string);
        break;
      case 'session_info':
        valid = optional(e.name, string);
        break;
    }
    if (!valid) fail();
  }
  if (version >= 2) {
    const done = new Set();
    for (const e of entries) {
      const path = new Set();
      let next = e;
      while (next && !done.has(next.id)) {
        if (path.has(next.id)) fail();
        path.add(next.id);
        if (next.parentId !== null && !byId.has(next.parentId)) fail();
        next = byId.get(next.parentId);
      }
      for (const id of path) done.add(id);
      for (const key of ['targetId', 'firstKeptEntryId'])
        if (e[key] !== undefined && !byId.has(e[key])) fail();
      if (e.type === 'context_edit') {
        const target = byId.get(e.targetId);
        if (
          !(
            target.type === 'custom_message' ||
            (target.type === 'message' &&
              ['user', 'assistant', 'toolResult'].includes(target.message.role))
          )
        )
          fail();
        if (
          e.replacement !== null &&
          !content(
            e.replacement.content,
            target.type === 'message' && target.message.role === 'assistant'
              ? ['text', 'thinking', 'toolCall']
              : ['text', 'image']
          )
        )
          fail();
        let ancestor = byId.get(e.parentId);
        let found = false;
        while (ancestor) {
          if (ancestor.id === e.targetId) {
            found = true;
            break;
          }
          ancestor = byId.get(ancestor.parentId);
        }
        if (!found) fail();
      }
    }
  }
  return { version, cwd: h.cwd, entries: entries.length, sessionId: h.id };
}
