import type { WebviewSnapshot } from '../state/types';
import { highlightCode } from './highlight';
import { chipPrivacyLabel, summarizeChip, type PendingContextItem } from './composer';
import { formatUsageChip } from './usageSummary';
import { editReplacements, editToolFilePath, type EditReplacement } from './editToolPath';

export const COMPOSER_FIELD_ID = 'composer-field';
export const ATTACH_TRIGGER_ID = 'attach-trigger';
export const SEND_BUTTON_ID = 'composer-send-button';
export const PREVIEW_DIALOG_ID = 'preview-panel';
export const PREVIEW_TITLE_ID = 'preview-title';
export const PREVIEW_DESCRIPTION_ID = 'preview-description';
export const PREVIEW_ACCEPT_BUTTON_ID = 'preview-accept-button';
export const PREVIEW_CANCEL_BUTTON_ID = 'preview-cancel-button';

export function contextChipRemoveButtonId(itemId: string): string {
  return `context-chip-remove-${itemId}`;
}

export function imageChipRemoveButtonId(itemId: string): string {
  return `image-chip-remove-${itemId}`;
}

export function focusTargetFromSnapshot(
  snapshot: Pick<WebviewSnapshot, 'focus' | 'preview' | 'pendingContextItems' | 'pendingImages'>
): string | undefined {
  if (snapshot.preview || snapshot.focus === 'preview') {
    return PREVIEW_ACCEPT_BUTTON_ID;
  }
  if (snapshot.focus === 'attach') {
    return ATTACH_TRIGGER_ID;
  }
  if (snapshot.focus === 'contextChip') {
    const item = snapshot.pendingContextItems.at(-1);
    return item ? contextChipRemoveButtonId(item.itemId) : ATTACH_TRIGGER_ID;
  }
  if (snapshot.focus === 'imageChip') {
    const item = snapshot.pendingImages.at(-1);
    return item ? imageChipRemoveButtonId(item.itemId) : ATTACH_TRIGGER_ID;
  }
  if (snapshot.focus === 'none') {
    return undefined;
  }
  return COMPOSER_FIELD_ID;
}

export function planChipRemovalFocus(
  snapshot: Pick<WebviewSnapshot, 'pendingContextItems' | 'pendingImages'>,
  itemId: string
): { targetId?: string; fallbackId: string } {
  const removeButtonIds = [
    ...snapshot.pendingContextItems.map((item) => contextChipRemoveButtonId(item.itemId)),
    ...snapshot.pendingImages.map((item) => imageChipRemoveButtonId(item.itemId)),
  ];
  const currentIndex = [contextChipRemoveButtonId(itemId), imageChipRemoveButtonId(itemId)].reduce(
    (match, buttonId) => (match >= 0 ? match : removeButtonIds.indexOf(buttonId)),
    -1
  );
  if (currentIndex >= 0 && currentIndex + 1 < removeButtonIds.length) {
    return { targetId: removeButtonIds[currentIndex + 1], fallbackId: ATTACH_TRIGGER_ID };
  }
  if (currentIndex > 0) {
    return { targetId: removeButtonIds[currentIndex - 1], fallbackId: ATTACH_TRIGGER_ID };
  }
  return { fallbackId: ATTACH_TRIGGER_ID };
}

export function nextPreviewTrapTarget(currentId: string | undefined, backwards = false): string {
  const actionIds: readonly [string, string] = [PREVIEW_ACCEPT_BUTTON_ID, PREVIEW_CANCEL_BUTTON_ID];
  const index = currentId ? actionIds.indexOf(currentId) : -1;
  const nextIndex =
    index < 0
      ? backwards
        ? 1
        : 0
      : (index + (backwards ? actionIds.length - 1 : 1)) % actionIds.length;
  return nextIndex === 0 ? actionIds[0] : actionIds[1];
}

export function shouldClearSnapshotFocus(
  focus: WebviewSnapshot['focus']
): focus is 'contextChip' | 'imageChip' | 'preview' {
  return focus === 'contextChip' || focus === 'imageChip' || focus === 'preview';
}

type MessageBlock = NonNullable<WebviewSnapshot['messages'][number]['blocks']>[number];

/**
 * Render a message as an ordered stream: consecutive TEXT blocks become the
 * chat bubble (clear, solid, per-role), while thinking / tool / tool-result /
 * image blocks render as separate, lighter, granular "meta" cards outside the
 * bubble so the actual conversation stays easy to read.
 */
function renderMessageStream(
  message: WebviewSnapshot['messages'][number],
  streamingAnswer = false
): string {
  const blocks: MessageBlock[] =
    message.blocks && message.blocks.length > 0
      ? message.blocks
      : message.text
        ? [{ kind: 'text', text: message.text }]
        : [];
  const out: string[] = [];
  let textRun: string[] = [];
  const flushText = (): void => {
    if (textRun.length > 0) {
      const raw = textRun.join('\n\n');
      const streamClass = streamingAnswer ? ' js-stream-text' : '';
      const streamData = streamingAnswer ? ` data-raw="${escapeHtml(raw)}"` : '';
      out.push(
        `<div class="message-body${streamClass}"${streamData}>${textRun
          .map((t) => renderRichText(t))
          .join('')}</div>`
      );
      textRun = [];
    }
  };
  for (const block of blocks) {
    if (block.kind === 'text') {
      textRun.push(block.text);
    } else {
      flushText();
      out.push(renderMetaBlock(block));
    }
  }
  flushText();
  return out.join('');
}

// Small, consistent 1.5px line icons (inline SVG, currentColor — no icon font,
// no emoji) so each section type is instantly recognizable.
const META_ICONS = {
  thinking:
    '<svg class="meta-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2.4l1.5 3.3 3.6.4-2.7 2.4.8 3.5L8 10.7 4.8 12.4l.8-3.5L2.9 6.5l3.6-.4z" fill="currentColor" stroke="none"/></svg>',
  tool: '<svg class="meta-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5L6.5 8l-3 3.5"/><path d="M8.5 11.5h4"/></svg>',
  result:
    '<svg class="meta-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.4l3 3 7-7.4"/></svg>',
  error:
    '<svg class="meta-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.8l5.4 9.4H2.6z"/><path d="M8 6.6v2.6"/><circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none"/></svg>',
  image:
    '<svg class="meta-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.75" y="3.75" width="10.5" height="8.5" rx="1.4"/><circle cx="6" cy="6.8" r="1"/><path d="M3.5 11.8l3-2.4 2 1.6 2.6-2.2 1.4 1.2"/></svg>',
  response:
    '<svg class="meta-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="2.4"/></svg>',
};

const CARET_ICON =
  '<svg class="tl-caret" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';

type TimelineNode = MessageBlock | { kind: 'response'; text: string };

/**
 * Assistant turns render as a TIMELINE of rounded, hairline-bordered cards
 * (fused "timeline + cards"): each step — thinking, tool call, tool result, and
 * the final answer — is a node with a colored dot on a connecting line. Simple
 * text-only replies skip the timeline and render as plain text.
 */
function renderAssistantBody(
  message: WebviewSnapshot['messages'][number],
  streamingAnswer = false,
  modelName = ''
): string {
  const blocks: MessageBlock[] =
    message.blocks && message.blocks.length > 0
      ? message.blocks
      : message.text
        ? [{ kind: 'text', text: message.text }]
        : [];
  // A settled assistant turn with NO content means the model returned nothing
  // (commonly a provider error / rate limit that Pi couldn't surface as an
  // event). Show a clear hint instead of a silent blank bubble.
  const hasAnyContent = blocks.some((block) =>
    block.kind === 'text' || block.kind === 'thinking' ? Boolean((block.text ?? '').trim()) : true
  );
  if (!hasAnyContent && !streamingAnswer) {
    const who = modelName ? `<strong>${escapeHtml(modelName)}</strong>` : 'The model';
    return `<div class="assistant-empty">${who} returned an empty response — it may be rate-limited or erroring. <button type="button" class="link-button" data-command="piRpcInternal.showLogs">Open Pi logs</button> or switch models.</div>`;
  }
  const hasProcess = blocks.some((block) => block.kind !== 'text');
  if (!hasProcess) {
    return renderMessageStream(message, streamingAnswer);
  }
  const nodes: TimelineNode[] = [];
  let textRun: string[] = [];
  const flush = (): void => {
    if (textRun.length > 0) {
      nodes.push({ kind: 'response', text: textRun.join('\n\n') });
      textRun = [];
    }
  };
  for (const block of blocks) {
    if (block.kind === 'text') {
      textRun.push(block.text);
    } else {
      flush();
      nodes.push(block);
    }
  }
  flush();
  return `<div class="timeline">${nodes
    .map((node, index) => renderTimelineNode(node, streamingAnswer && index === nodes.length - 1))
    .join('')}</div>`;
}

// Rich diff for `edit` tool cards: removed lines (−) then added lines (+),
// coloured with the theme's diff palette. Long diffs get a Show more toggle.
function renderEditDiff(replacements: EditReplacement[]): string {
  const lines: string[] = [];
  for (const replacement of replacements) {
    for (const line of replacement.oldText ? replacement.oldText.split('\n') : []) {
      lines.push(`<div class="diff-line diff-del">${escapeHtml(line)}</div>`);
    }
    for (const line of replacement.newText ? replacement.newText.split('\n') : []) {
      lines.push(`<div class="diff-line diff-add">${escapeHtml(line)}</div>`);
    }
  }
  const diff = `<div class="edit-diff" role="group" aria-label="File edit diff">${lines.join('')}</div>`;
  if (lines.length > 24) {
    return `<div class="clampable"><div class="clamp-body">${diff}</div><button type="button" class="code-showmore">Show more</button></div>`;
  }
  return diff;
}

// #7 — long tool/result output is clamped with a "Show more" toggle so big logs
// (package lists, stack traces) don't dominate the transcript.
function renderClampedOutput(text: string): string {
  const pre = `<pre class="code-block"><code>${escapeHtml(text)}</code></pre>`;
  const long = text.length > 1400 || text.split('\n').length > 16;
  if (!long) {
    return pre;
  }
  return `<div class="clampable"><div class="clamp-body">${pre}</div><button type="button" class="code-showmore">Show more</button></div>`;
}

// --- JSON pretty rendering ------------------------------------------------
// Tool args and tool results are frequently JSON. Raw JSON is hard to scan, so
// render objects as key/value grids and arrays-of-objects as columnar tables
// (recursively), which matches the "tabular for clarity" goal. Non-JSON falls
// back to the plain preformatted block.
const JSON_MAX_DEPTH = 8;

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 200_000) {
    return undefined;
  }
  const first = trimmed[0];
  if (first !== '{' && first !== '[') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonScalar(value: unknown): string {
  if (value === null) {
    return '<span class="json-null">null</span>';
  }
  if (typeof value === 'boolean') {
    return `<span class="json-bool">${value ? 'true' : 'false'}</span>`;
  }
  if (typeof value === 'number') {
    return `<span class="json-num">${escapeHtml(String(value))}</span>`;
  }
  return `<span class="json-str">${escapeHtml(String(value))}</span>`;
}

function jsonTable(inner: string): string {
  return `<div class="md-table-wrap json-table-wrap"><table class="md-table json-table">${inner}</table></div>`;
}

function renderJsonValue(value: unknown, depth = 0): string {
  if (value === null || typeof value !== 'object') {
    return jsonScalar(value);
  }
  if (depth >= JSON_MAX_DEPTH) {
    // Too deep to keep nesting tables — pretty-print (readable) instead of a
    // compact one-line dump.
    return `<pre class="code-block json-deep"><code>${escapeHtml(
      JSON.stringify(value, null, 2)
    )}</code></pre>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<span class="json-empty">[ ]</span>';
    }
    // Array of objects -> one column per key (union, first-seen order).
    if (value.every(isPlainObject)) {
      const cols: string[] = [];
      for (const item of value) {
        for (const key of Object.keys(item)) {
          if (!cols.includes(key)) {
            cols.push(key);
          }
        }
      }
      const head = cols.map((col) => `<th>${escapeHtml(col)}</th>`).join('');
      const rows = value
        .map(
          (item) =>
            `<tr>${cols
              .map((col) => `<td>${col in item ? renderJsonValue(item[col], depth + 1) : ''}</td>`)
              .join('')}</tr>`
        )
        .join('');
      return jsonTable(`<thead><tr>${head}</tr></thead><tbody>${rows}</tbody>`);
    }
    // Mixed/scalar array -> indexed rows.
    const rows = value
      .map(
        (item, index) =>
          `<tr><td class="json-key">${index}</td><td>${renderJsonValue(item, depth + 1)}</td></tr>`
      )
      .join('');
    return jsonTable(`<tbody>${rows}</tbody>`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return '<span class="json-empty">{ }</span>';
  }
  const rows = entries
    .map(
      ([key, val]) =>
        `<tr><td class="json-key">${escapeHtml(key)}</td><td>${renderJsonValue(val, depth + 1)}</td></tr>`
    )
    .join('');
  return jsonTable(`<tbody>${rows}</tbody>`);
}

// A JSON value from Pi's ANSWER, shown as a structured table with a toggle to
// reveal/copy the raw JSON.
function renderJsonBlock(value: unknown, raw: string): string {
  return `<div class="json-block" data-json-block><div class="json-block-bar"><span class="json-block-label">JSON</span><button type="button" class="json-toggle" data-mode="table" aria-pressed="false" title="Toggle table / raw JSON">Raw</button></div><div class="json-block-view">${renderJsonValue(value)}</div><pre class="code-block json-raw" hidden><code class="hljs language-json">${escapeHtml(raw)}</code></pre></div>`;
}

// Render tool args / results: as a structured JSON table when the content is
// JSON, otherwise as the plain preformatted block. Long output stays clamped.
function renderToolContent(text: string): string {
  const parsed = tryParseJson(text);
  const inner =
    parsed !== undefined
      ? `<div class="json-view">${renderJsonValue(parsed)}</div>`
      : `<pre class="code-block"><code>${escapeHtml(text)}</code></pre>`;
  const long = text.length > 1400 || text.split('\n').length > 16;
  if (!long) {
    return inner;
  }
  return `<div class="clampable"><div class="clamp-body">${inner}</div><button type="button" class="code-showmore">Show more</button></div>`;
}

function renderTimelineNode(node: TimelineNode, streamingAnswer = false): string {
  // Small colored marker on the rail; the identifying icon lives in the card
  // header (icon + rounded border make each section obvious).
  const marker = '<span class="tl-dot"></span>';
  switch (node.kind) {
    case 'thinking':
      return `<div class="tl-node tl-thinking">${marker}<details class="tl-card" open><summary class="tl-head">${META_ICONS.thinking}<span class="tl-label">Thinking</span>${CARET_ICON}</summary><div class="tl-body tl-think">${renderRichText(node.text)}</div></details></div>`;
    case 'tool': {
      const editPath = editToolFilePath(node.name, node.args);
      const replacements = editReplacements(node.name, node.args);
      const body =
        replacements.length > 0
          ? renderEditDiff(replacements)
          : node.args
            ? renderToolContent(node.args)
            : '';
      const fileActions = editPath
        ? `<div class="tl-file-actions"><span class="tl-file-path">${escapeHtml(editPath)}</span><button type="button" class="tl-file-btn" data-file-open="${escapeHtml(editPath)}">Open file</button><button type="button" class="tl-file-btn" data-file-diff="${escapeHtml(editPath)}">Open changes</button></div>`
        : '';
      return `<div class="tl-node tl-tool">${marker}<div class="tl-card"><div class="tl-head">${META_ICONS.tool}<span class="tl-label">Tool</span><code class="tool-name">${escapeHtml(node.name)}</code></div>${body}${fileActions}</div></div>`;
    }
    case 'toolResult': {
      const err = node.isError === true;
      // Results collapse by default (they're often long/noisy); errors stay open.
      return `<div class="tl-node tl-result${err ? ' is-error' : ''}">${marker}<details class="tl-card"${err ? ' open' : ''}><summary class="tl-head">${err ? META_ICONS.error : META_ICONS.result}<span class="tl-label">${err ? 'Error' : 'Result'}</span>${node.name ? `<code class="tool-name">${escapeHtml(node.name)}</code>` : ''}${CARET_ICON}</summary>${renderToolContent(node.text)}</details></div>`;
    }
    case 'image':
      return `<div class="tl-node tl-tool">${marker}<div class="tl-card"><div class="tl-head">${META_ICONS.image}<span class="tl-label">Image</span><span class="tool-name">${escapeHtml(node.mimeType)}</span></div></div></div>`;
    case 'response': {
      const streamClass = streamingAnswer ? ' js-stream-text' : '';
      const streamData = streamingAnswer ? ` data-raw="${escapeHtml(node.text)}"` : '';
      return `<div class="tl-node tl-response">${marker}<div class="tl-card tl-answer"><div class="tl-head tl-answer-head">${META_ICONS.response}<span class="tl-label">π</span></div><div class="tl-body${streamClass}"${streamData}>${renderRichText(node.text)}</div></div></div>`;
    }
    default:
      return '';
  }
}

function metaLabel(iconKey: keyof typeof META_ICONS, text: string): string {
  return `${META_ICONS[iconKey]}<span class="meta-label">${escapeHtml(text)}</span>`;
}

function renderMetaBlock(block: MessageBlock): string {
  switch (block.kind) {
    case 'thinking':
      return `<details class="meta-block meta-thinking"><summary class="meta-head">${metaLabel('thinking', 'Thinking')}</summary><div class="meta-body">${renderRichText(block.text)}</div></details>`;
    case 'tool':
      return `<div class="meta-block meta-tool"><div class="meta-head">${metaLabel('tool', 'Tool')}<code class="tool-name">${escapeHtml(block.name)}</code></div>${block.args ? renderToolContent(block.args) : ''}</div>`;
    case 'toolResult': {
      const err = block.isError === true;
      return `<details class="meta-block meta-tool-result${err ? ' is-error' : ''}"><summary class="meta-head">${metaLabel(err ? 'error' : 'result', err ? 'Tool error' : 'Tool result')}${block.name ? `<code class="tool-name">${escapeHtml(block.name)}</code>` : ''}</summary>${renderToolContent(block.text)}</details></div>`;
    }
    case 'image':
      return `<div class="meta-block meta-image meta-head">${metaLabel('image', 'Image')}<span class="tool-name">${escapeHtml(block.mimeType)}</span></div>`;
    default:
      return '';
  }
}

/**
 * Render message text with fenced code blocks (```lang) and inline `code`.
 * Everything is HTML-escaped first; no raw markup is ever emitted.
 */
// Inline Markdown: escape first, then code / links / bold / italic. Order
// matters so ** inside `code` isn't bolded.
function renderInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  // Inline code first so its contents aren't transformed by later passes.
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  // Images ![alt](url): rendered as a safe labeled link (CSP forbids remote
  // image fetches, and embedding arbitrary remote images is a tracking vector).
  html = html.replace(
    /!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, alt: string, url: string) =>
      `<a class="md-link md-img-link" data-href="${url}">\u{1F5BC} ${alt || 'image'}</a>`
  );
  // Explicit links [text](url).
  html = html.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => `<a class="md-link" data-href="${url}">${label}</a>`
  );
  // Autolink bare URLs. The `(^|[\s(])` prefix prevents matching URLs already
  // moved into a data-href="…" attribute above (those are preceded by a quote).
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g, (_m, pre: string, url: string) => {
    const trailing = /[.,;:!?]+$/.exec(url);
    const clean = trailing ? url.slice(0, url.length - trailing[0].length) : url;
    const tail = trailing ? trailing[0] : '';
    return `${pre}<a class="md-link" data-href="${clean}">${clean}</a>${tail}`;
  });
  html = html.replace(/\*\*(?!\s)([^\n*]+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<![\w*])\*(?!\s)([^\n*]+?)\*(?![\w*])/g, '<em>$1</em>');
  html = html.replace(/(?<![\w_])_(?!\s)([^\n_]+?)_(?![\w_])/g, '<em>$1</em>');
  // Strikethrough ~~text~~ (GFM).
  html = html.replace(/~~(?!\s)([^\n~]+?)~~/g, '<del>$1</del>');
  return html;
}

// --- lists (nested + GFM task lists) --------------------------------------
interface ListItem {
  indent: number;
  ordered: boolean;
  task: boolean | null; // null = not a task item; true/false = checked state
  content: string;
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function consumeListItems(lines: string[], start: number): { items: ListItem[]; next: number } {
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM_RE.exec(lines[i] ?? '');
    if (!match) {
      break;
    }
    let content = match[3] ?? '';
    let task: boolean | null = null;
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (taskMatch) {
      task = (taskMatch[1] ?? ' ').toLowerCase() === 'x';
      content = taskMatch[2] ?? '';
    }
    items.push({
      indent: (match[1] ?? '').length,
      ordered: /\d/.test(match[2] ?? ''),
      task,
      content,
    });
    i += 1;
  }
  return { items, next: i };
}

function buildListHtml(
  items: ListItem[],
  pos: number,
  indent: number
): { html: string; pos: number } {
  const ordered = items[pos]!.ordered;
  const tag = ordered ? 'ol' : 'ul';
  const cls = ordered ? 'md-ol' : 'md-ul';
  let html = `<${tag} class="${cls}">`;
  let cursor = pos;
  while (cursor < items.length && items[cursor]!.indent >= indent) {
    if (items[cursor]!.indent > indent) {
      // Deeper items are handled as children of the previous <li>; a stray
      // over-indent with no parent is absorbed at this level defensively.
      const child = buildListHtml(items, cursor, items[cursor]!.indent);
      html += child.html;
      cursor = child.pos;
      continue;
    }
    const item = items[cursor]!;
    cursor += 1;
    let inner = '';
    if (cursor < items.length && items[cursor]!.indent > indent) {
      const child = buildListHtml(items, cursor, items[cursor]!.indent);
      inner = child.html;
      cursor = child.pos;
    }
    if (item.task === null) {
      html += `<li>${renderInlineMarkdown(item.content)}${inner}</li>`;
    } else {
      const checked = item.task ? ' checked' : '';
      html +=
        `<li class="md-task"><input type="checkbox" disabled${checked} />` +
        `<span>${renderInlineMarkdown(item.content)}</span>${inner}</li>`;
    }
  }
  html += `</${tag}>`;
  return { html, pos: cursor };
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line)
  );
}

// --- GFM tables -----------------------------------------------------------
// A table is a header row of `|`-separated cells immediately followed by a
// delimiter row (e.g. `| --- | :--: | ---: |`). Rendered as a real <table> so
// columns align in the proportional webview font (space-padded ASCII, which the
// monospace TUI relies on, cannot align in the GUI).
type TableAlign = 'left' | 'center' | 'right' | '';

function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  // Must contain a dash and at least one column separator to be a delimiter row.
  if (!trimmed.includes('-')) {
    return false;
  }
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
}

function isTableStart(current: string, next: string): boolean {
  return current.includes('|') && current.trim().length > 0 && isTableDelimiterRow(next);
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function cellAlignment(spec: string): TableAlign {
  const trimmed = spec.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

function renderTable(header: string[], aligns: TableAlign[], rows: string[][]): string {
  const style = (index: number): string =>
    aligns[index] ? ` style="text-align:${aligns[index]}"` : '';
  const head = header
    .map((cell, index) => `<th${style(index)}>${renderInlineMarkdown(cell)}</th>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${header
          .map((_, index) => `<td${style(index)}>${renderInlineMarkdown(row[index] ?? '')}</td>`)
          .join('')}</tr>`
    )
    .join('');
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Block-level Markdown: headings, lists, blockquotes, hr, paragraphs.
function renderMarkdownBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<div class="md-h md-h${level}">${renderInlineMarkdown(heading[2] ?? '')}</div>`);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<hr class="md-hr" />');
      i += 1;
      continue;
    }
    if (isTableStart(line, lines[i + 1] ?? '')) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1] ?? '').map(cellAlignment);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      out.push(renderTable(header, aligns, rows));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(
        `<blockquote class="md-quote">${renderMarkdownBlock(quoted.join('\n'))}</blockquote>`
      );
      continue;
    }
    if (LIST_ITEM_RE.test(line)) {
      const { items, next } = consumeListItems(lines, i);
      const baseIndent = Math.min(...items.map((item) => item.indent));
      out.push(buildListHtml(items, 0, baseIndent).html);
      i = next;
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !isBlockStart(lines[i] ?? '') &&
      !isTableStart(lines[i] ?? '', lines[i + 1] ?? '')
    ) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    out.push(`<p class="msg-para">${renderInlineMarkdown(para.join('\n'))}</p>`);
  }
  return out.join('');
}

export function renderRichText(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  let buffer: string[] = [];
  const flushParagraph = (): void => {
    if (buffer.length === 0) {
      return;
    }
    out.push(renderMarkdownBlock(buffer.join('\n')));
    buffer = [];
  };
  let index = 0;
  while (index < lines.length) {
    const fence = /^```(\w*)\s*$/.exec(lines[index] ?? '');
    if (fence) {
      flushParagraph();
      const language = fence[1] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // skip closing fence
      const codeText = code.join('\n');
      // JSON in Pi's ANSWER: render it as the same structured table used for
      // tool output (easier to read than raw JSON), with a toggle to view/copy
      // the raw JSON. Only for an explicit ```json fence or an unlabeled fence
      // whose content actually parses as a JSON object/array — real code in
      // other languages is left as a highlighted code block.
      const fenceLang = language.trim().toLowerCase();
      const jsonFenceLangs = new Set(['', 'json', 'json5', 'jsonc', 'text', 'txt', 'output']);
      const jsonValue = jsonFenceLangs.has(fenceLang) ? tryParseJson(codeText) : undefined;
      if (jsonValue !== undefined) {
        out.push(renderJsonBlock(jsonValue, codeText));
        continue;
      }
      // Syntax-highlight the block (falls back to plain escaped text). The
      // resolved language (explicit or auto-detected) drives the label + class.
      const highlighted = highlightCode(codeText, language, escapeHtml);
      const labelLang = language.trim() || highlighted.language || '';
      // Fenced code renders as its OWN block with a Copy button. Only show a
      // language label for a REAL language — never a generic "text"/"code".
      const generic = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'code', 'output', 'log']);
      const showLang = !generic.has(labelLang.toLowerCase());
      const langSlot = showLang
        ? `<span class="code-lang-name">${escapeHtml(labelLang)}</span>`
        : '<span class="code-lang-spacer"></span>';
      const codeClass = highlighted.language
        ? `hljs language-${escapeHtml(highlighted.language)}`
        : 'hljs';
      out.push(
        `<div class="code-wrap" data-lang="${escapeHtml(language)}"><div class="code-lang">${langSlot}<div class="code-actions"><button type="button" class="code-btn code-insert" title="Insert at cursor in the active editor" aria-label="Insert code at cursor">Insert</button><button type="button" class="code-btn code-newfile" title="Open in a new file" aria-label="Open code in a new file">New file</button><button type="button" class="code-btn code-copy" aria-label="Copy code">Copy</button></div></div><pre class="code-block"><code class="${codeClass}">${highlighted.html}</code></pre></div>`
      );
    } else {
      buffer.push(lines[index] ?? '');
      index += 1;
    }
  }
  flushParagraph();
  return out.join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sessionLabel(snapshot: WebviewSnapshot): string {
  return snapshot.sessionName ?? snapshot.sessionId ?? snapshot.sessionFile ?? 'No chat yet';
}

// Tool-approval prompts (extension UI select/confirm) rendered inline as
// Allow/Deny cards instead of a native modal, so the request is visible in the
// conversation and answered in one click.
function renderApprovals(snapshot: WebviewSnapshot): string {
  const approvals = snapshot.approvals ?? [];
  if (approvals.length === 0) {
    return '';
  }
  return approvals
    .map((approval) => {
      const heading = escapeHtml(approval.title ?? 'π needs your approval');
      const body = approval.message
        ? `<p class="approval-msg">${escapeHtml(approval.message)}</p>`
        : '';
      const buttons =
        approval.method === 'confirm'
          ? `<button type="button" class="approval-btn approval-allow" data-ui-id="${escapeHtml(approval.id)}" data-ui-confirmed="true">Allow</button><button type="button" class="approval-btn approval-deny" data-ui-id="${escapeHtml(approval.id)}" data-ui-confirmed="false">Deny</button>`
          : (approval.options ?? [])
              .map(
                (option) =>
                  `<button type="button" class="approval-btn" data-ui-id="${escapeHtml(approval.id)}" data-ui-value="${escapeHtml(option)}">${escapeHtml(option)}</button>`
              )
              .join('');
      return `<div class="approval-card" role="alertdialog" aria-label="${heading}"><div class="approval-head">${heading}</div>${body}<div class="approval-actions">${buttons}</div></div>`;
    })
    .join('');
}

// #5 — compact tokens / context% / cost chip. Click opens full session stats.
// Cost is a read-only, non-interactive label (not a button).
function renderCostLabel(snapshot: WebviewSnapshot): string {
  const usage = snapshot.usage;
  if (!usage) {
    return '';
  }
  const label = formatUsageChip(usage);
  if (!label) {
    return '';
  }
  return `<span class="cost-label" title="Session cost">${escapeHtml(label)}</span>`;
}

// Model = clean, borderless, clickable label (mint dot + name).
function renderModelControl(snapshot: WebviewSnapshot): string {
  return `<button type="button" class="model-label" data-command="piRpc.showModels" title="Choose model" aria-label="Choose model"><span class="model-dot"></span><span class="model-name">${escapeHtml(modelLabel(snapshot))}</span></button>`;
}

// Chat header ("sidecar" top bar): per-chat overflow actions live here.
// (chat header removed — the editor TAB shows the chat name + icon, and chat
// actions live in the NATIVE editor title bar via the piRpc.chatActions submenu.
// The multi-root workspace picker moved into the composer toolbar.)

function modelLabel(snapshot: WebviewSnapshot): string {
  return snapshot.model?.provider && snapshot.model?.id
    ? `${snapshot.model.provider}/${snapshot.model.id}`
    : 'Model';
}

function statusLabel(snapshot: WebviewSnapshot): string {
  if (snapshot.isStreaming) {
    return 'π is replying';
  }
  if (snapshot.isCompacting) {
    return 'Compacting';
  }
  if (snapshot.connectionState === 'faulted') {
    return 'Needs attention';
  }
  if (snapshot.connectionState === 'starting' || snapshot.connectionState === 'handshaking') {
    return 'Starting';
  }
  if (snapshot.connectionState === 'stopped') {
    return 'Ready to start';
  }
  return 'Ready';
}

function renderAttachment(
  attachment: WebviewSnapshot['messages'][number]['attachments'][number]
): string {
  const bits = [
    attachment.name,
    attachment.mimeType,
    attachment.size !== undefined ? `${attachment.size}b` : undefined,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => `<span class="meta-pill">${escapeHtml(value)}</span>`)
    .join('');
  return `
    <details class="message-attachment">
      <summary>${escapeHtml(attachment.type)}${attachment.name ? ` · ${escapeHtml(attachment.name)}` : ''}</summary>
      <div class="detail-stack">
        <div>${bits}</div>
        ${attachment.extractedText ? `<pre>${escapeHtml(attachment.extractedText)}</pre>` : ''}
        ${attachment.previewItems
          .map(
            (item) =>
              `<div><strong>${escapeHtml(item.key)}:</strong> ${escapeHtml(item.value)}</div>`
          )
          .join('')}
        ${attachment.fileRef ? `<button type="button" data-attachment-uri="${escapeHtml(attachment.fileRef.uri)}">Open ${escapeHtml(attachment.fileRef.path)}</button>` : ''}
      </div>
    </details>`;
}

function renderMessages(snapshot: WebviewSnapshot): string {
  if (snapshot.messages.length === 0) {
    return `
      <div class="empty-state" data-testid="empty-state">
        <svg class="empty-mascot" width="64" height="48" viewBox="0 0 8 6" role="img" aria-label="π" shape-rendering="crispEdges">
          <rect x="1" y="1" width="6" height="4" fill="currentColor" />
          <rect x="2" y="2" width="1" height="1" fill="var(--vscode-editor-background)" />
          <rect x="5" y="2" width="1" height="1" fill="var(--vscode-editor-background)" />
          <rect x="1" y="5" width="1" height="1" fill="currentColor" />
          <rect x="3" y="5" width="1" height="1" fill="currentColor" />
          <rect x="6" y="5" width="1" height="1" fill="currentColor" />
        </svg>
        <p class="empty-title">Start a chat with Pi</p>
        <p class="empty-copy">Ask about this codebase, or start writing code.</p>
        <div class="empty-examples">
          <button type="button" class="empty-example" data-example="Give me a high-level overview of this project's structure and how the main pieces fit together.">Explain this codebase</button>
          <button type="button" class="empty-example" data-example="Add tests for the file I currently have open.">Add tests for a file</button>
          <button type="button" class="empty-example" data-example="Find and fix a bug in ">Find and fix a bug</button>
        </div>
        <p class="empty-hints"><kbd>/</kbd> commands &middot; <kbd>@</kbd> mention a file &middot; <kbd>Cmd/Ctrl+K</kbd> actions</p>
      </div>`;
  }
  const olderSentinel = snapshot.messageWindow?.hasOlder
    ? `<div id="older-sentinel" class="older-sentinel" role="status"><span class="spinner spinner-sm" aria-hidden="true"></span>Loading earlier messages…</div>`
    : '';
  const busy = snapshot.connectionState === 'busy';
  const modelName = modelLabel(snapshot);
  return (
    olderSentinel +
    snapshot.messages
      .map((message, index, all) => {
        const isLast = index === all.length - 1;
        return renderMessageArticle(
          message,
          isLast,
          busy && isLast && message.role === 'assistant',
          modelName
        );
      })
      .join('')
  );
}

// Pi emits tool results (and bash executions) as SEPARATE messages with these
// roles — not as content blocks inside the assistant message. They must render
// with the same card pattern as the rest of the timeline.
function isResultRole(role: string): boolean {
  return (
    role === 'toolResult' || role === 'tool' || role === 'tool_result' || role === 'bashExecution'
  );
}

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 10.5V4a1.5 1.5 0 0 1 1.5-1.5H10"/></svg>';
const EDIT_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3.5l2 2L6 12l-2.5.5L4 10z"/></svg>';

function renderMessageArticle(
  message: WebviewSnapshot['messages'][number],
  isLast = false,
  streamingAnswer = false,
  modelName = ''
): string {
  const role = message.role;
  const roleLabel = role === 'assistant' ? 'π' : role === 'user' ? 'You' : '';
  const showCopy = role === 'assistant' || role === 'user';
  // (content-visibility virtualization removed — see chat.css note; it caused
  // scrollbar jumpiness. `isLast` retained for future use.)
  void isLast;
  return `
        <article class="message-card message-${escapeHtml(role)}"${roleLabel ? ` aria-label="${roleLabel} said"` : ''}>
          ${roleLabel ? `<div class="message-role">${roleLabel}</div>` : ''}
          ${renderMessageBody(message, streamingAnswer, modelName)}
          ${message.attachments.length > 0 ? `<div class="detail-stack">${message.attachments.map((attachment) => renderAttachment(attachment)).join('')}</div>` : ''}
          ${showCopy ? `<div class="msg-actions">${role === 'user' ? `<button type="button" class="msg-edit" title="Edit &amp; restart from here" aria-label="Edit and restart the chat from this message">${EDIT_ICON}</button>` : ''}<button type="button" class="msg-copy" title="Copy message" aria-label="Copy message">${COPY_ICON}</button></div>` : ''}
        </article>`;
}

function renderMessageBody(
  message: WebviewSnapshot['messages'][number],
  streamingAnswer = false,
  modelName = ''
): string {
  if (message.role === 'assistant') {
    return renderAssistantBody(message, streamingAnswer, modelName);
  }
  if (isResultRole(message.role)) {
    return renderResultMessage(message);
  }
  return renderMessageStream(message);
}

/** A standalone tool-result / bash-execution message rendered as a Result card. */
function renderResultMessage(message: WebviewSnapshot['messages'][number]): string {
  const text = message.text ?? '';
  return `<div class="timeline timeline-standalone"><div class="tl-node tl-result"><span class="tl-dot"></span><details class="tl-card"><summary class="tl-head">${META_ICONS.result}<span class="tl-label">Result</span>${CARET_ICON}</summary>${renderClampedOutput(text)}</details></div></div>`;
}

function renderContextChip(item: PendingContextItem): string {
  const stale = item.stale ? ' chip-stale' : '';
  const meta =
    item.kind === 'diagnostics'
      ? `${item.workspaceRelativePath} · ${item.issueCount} issues`
      : `${item.workspaceRelativePath} · L${item.lineStart}-${item.lineEnd}`;
  return `
    <div class="chip-shell" role="listitem" data-chip-id="${escapeHtml(item.itemId)}" data-chip-kind="context">
      <details class="chip-details${stale}">
        <summary>${escapeHtml(summarizeChip(item))}</summary>
        <div class="detail-stack">
          <div class="muted">${escapeHtml(meta)}</div>
          <div class="muted">${escapeHtml(chipPrivacyLabel(item))}</div>
          ${item.stale ? `<div class="warning-text">Expired${item.staleReason ? ` · ${escapeHtml(item.staleReason)}` : ''}</div>` : ''}
          <pre>${escapeHtml(item.sanitizedContent)}</pre>
        </div>
      </details>
      <button
        type="button"
        class="chip-remove-button"
        id="${escapeHtml(contextChipRemoveButtonId(item.itemId))}"
        data-chip-remove-id="${escapeHtml(item.itemId)}"
        data-remove-context="${escapeHtml(item.itemId)}"
        aria-label="Remove ${escapeHtml(summarizeChip(item))}"
        title="Remove"
      >×</button>
    </div>`;
}

function renderImageChip(snapshot: WebviewSnapshot): string {
  return snapshot.pendingImages
    .map(
      (item) => `
        <div class="chip-shell" role="listitem" data-chip-id="${escapeHtml(item.itemId)}" data-chip-kind="image">
          <details class="chip-details${item.requiresReselect ? ' chip-stale' : ''}">
            <summary>${escapeHtml(item.requiresReselect ? `Reselect image: ${item.name}` : `Image: ${item.name}`)}</summary>
            <div class="detail-stack">
              <div class="muted">${escapeHtml(item.mimeType)} · ${item.sizeBytes} bytes</div>
              <div class="muted">Local image · sent on next message only</div>
              ${item.previewDataUrl && !item.requiresReselect ? `<img class="image-preview" src="${escapeHtml(item.previewDataUrl)}" alt="Preview of ${escapeHtml(item.name)}" />` : ''}
              ${item.requiresReselect ? `<div class="warning-text">Expired image selection</div>` : ''}
            </div>
          </details>
          <button
            type="button"
            class="chip-remove-button"
            id="${escapeHtml(imageChipRemoveButtonId(item.itemId))}"
            data-chip-remove-id="${escapeHtml(item.itemId)}"
            data-remove-image="${escapeHtml(item.itemId)}"
            aria-label="Remove image ${escapeHtml(item.name)}"
            title="Remove"
          >×</button>
        </div>`
    )
    .join('');
}

function renderRecovery(snapshot: WebviewSnapshot): string {
  if (!snapshot.recovery) {
    return '';
  }
  const isSendFailure = snapshot.recovery.kind === 'sendFailure';
  return `
    <section class="banner ${snapshot.recovery.kind}">
      <div>
        <strong>${escapeHtml(snapshot.recovery.title)}</strong>
        <div class="muted">${escapeHtml(snapshot.recovery.detail)}</div>
      </div>
      <div class="button-row compact">
        ${snapshot.recovery.kind === 'startFailure' ? '<button type="button" data-command="piRpcInternal.start">Start again</button>' : ''}
        ${snapshot.recovery.kind === 'disconnected' ? '<button type="button" data-command="piRpcInternal.restart">Restart Pi</button><button type="button" data-command="piRpc.switchSession">Resume another chat</button>' : ''}
        ${isSendFailure ? '<button type="button" data-action="copyAcceptedSnapshot">Copy to composer</button><button type="button" data-action="sendAcceptedSnapshotAgain">Send again</button>' : ''}
      </div>
    </section>`;
}

function renderPreview(snapshot: WebviewSnapshot): string {
  if (!snapshot.preview) {
    return '';
  }
  return `
    <section class="modal-backdrop">
      <div
        class="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="${PREVIEW_TITLE_ID}"
        aria-describedby="${PREVIEW_DESCRIPTION_ID}"
        id="${PREVIEW_DIALOG_ID}"
        tabindex="-1"
      >
        <h2 id="${PREVIEW_TITLE_ID}">Preview before send</h2>
        <p class="muted" id="${PREVIEW_DESCRIPTION_ID}">This is the exact Pi payload that will be sent.</p>
        <div class="detail-stack">
          <div><strong>Command:</strong> ${escapeHtml(snapshot.preview.command)}</div>
          <div><strong>Images:</strong> ${snapshot.preview.imageItems.length}</div>
          <pre>${escapeHtml(snapshot.preview.rpcMessage)}</pre>
        </div>
        ${
          snapshot.preview.imageItems.length > 0
            ? `<div class="detail-stack">${snapshot.preview.imageItems
                .map(
                  (item) =>
                    `<div class="meta-row"><span>${escapeHtml(item.name)}</span><span class="muted">${escapeHtml(item.mimeType)} · ${item.sizeBytes} bytes</span></div>`
                )
                .join('')}</div>`
            : ''
        }
        <div class="button-row">
          <button type="button" id="${PREVIEW_ACCEPT_BUTTON_ID}" data-action="acceptPreview">Send</button>
          <button type="button" id="${PREVIEW_CANCEL_BUTTON_ID}" data-action="cancelPreview">Cancel</button>
        </div>
      </div>
    </section>`;
}

// Font size/family overrides applied as CSS variables on the root.
function chatFontStyle(snapshot: WebviewSnapshot): string {
  const parts: string[] = [];
  if (snapshot.chatFontSize && snapshot.chatFontSize > 0) {
    parts.push(`--pi-chat-font-size:${Math.round(snapshot.chatFontSize)}px`);
  }
  if (snapshot.chatFontFamily && snapshot.chatFontFamily.trim()) {
    parts.push(`--pi-chat-font-family:${escapeHtml(snapshot.chatFontFamily.replace(/[";]/g, ''))}`);
  }
  return parts.length > 0 ? ` style="${parts.join(';')}"` : '';
}

// A "working" animation shown while Pi generates (like the TUI spinner).
function renderWorking(snapshot: WebviewSnapshot): string {
  const anim = snapshot.workingAnimation || 'braille';
  return `<span class="working" data-anim="${escapeHtml(anim)}" role="status" aria-label="π is working"><span class="working-glyph"></span></span>`;
}

// The working indicator sits as a banner at the top of the composer so it is
// clearly visible while Pi is generating.
// Persistent info bar shown on a chat that is being shared to a remote device.
function renderShareBar(snapshot: WebviewSnapshot): string {
  if (!snapshot.sharing?.active) {
    return '';
  }
  return `<section class="share-bar" role="status" aria-live="polite"><span class="share-dot" aria-hidden="true"></span><span class="share-text">Shared with ${escapeHtml(snapshot.sharing.label)}</span><button type="button" class="share-stop" data-command="piRpc.remote.stop" title="Stop sharing this chat">Stop sharing</button></section>`;
}

function renderWorkingBanner(snapshot: WebviewSnapshot): string {
  return `<div class="working-banner">${renderWorking(snapshot)}<span class="working-label">Working\u2026</span></div>`;
}

// Queued steering / follow-up messages the user lined up while Pi was busy.
function renderQueueTray(snapshot: WebviewSnapshot): string {
  const queue = snapshot.queue;
  const items = [
    ...(queue?.steering ?? []).map((text) => ({ kind: 'Steering', text })),
    ...(queue?.followUp ?? []).map((text) => ({ kind: 'Follow-up', text })),
  ];
  if (items.length === 0) {
    return '';
  }
  const rows = items
    .map(
      (item) =>
        `<div class="queue-item"><span class="queue-kind">${item.kind}</span><span class="queue-text">${escapeHtml(item.text)}</span></div>`
    )
    .join('');
  return `<div class="queue-tray"><div class="section-label">Queued for π</div>${rows}</div>`;
}

export function renderChatApp(snapshot: WebviewSnapshot): string {
  const busy = snapshot.isStreaming || snapshot.connectionState === 'busy';
  const interactive = snapshot.connectionState === 'ready' || snapshot.connectionState === 'busy';
  const faulted = snapshot.connectionState === 'faulted';
  // Show the loading spinner while connecting OR while switching to another
  // session (the latter keeps connectionState 'ready' so switches don't deadlock,
  // so it needs its own signal).
  const connecting = (!interactive && !faulted) || snapshot.switchingSession === true;
  const disabledAttr = interactive ? '' : 'disabled';
  const sendLabel = busy ? 'Send next (Enter)' : 'Send (Enter · Shift+Enter for newline)';
  const sendCommand = busy ? 'follow_up' : 'prompt';
  const bindingLabel =
    snapshot.bindingState === 'cached'
      ? 'Cached'
      : snapshot.bindingState === 'draft'
        ? 'New draft'
        : 'Current';
  const summaryLine = `${bindingLabel} · ${snapshot.workspaceFolderName} · ${sessionLabel(snapshot)} · ${statusLabel(snapshot)}`;
  const attachmentsVisible =
    snapshot.pendingContextItems.length > 0 || snapshot.pendingImages.length > 0;
  const restrictedBanner = snapshot.isTrusted
    ? ''
    : `<section class="banner info"><strong>Restricted Mode</strong><div class="muted">Restricted Mode: chat can read, but changes stay disabled until you trust this workspace.</div></section>`;

  const folderSelect =
    snapshot.folders.length > 1
      ? `<label class="inline-select"><span class="visually-hidden">Workspace</span><select id="folder-select" aria-label="Choose workspace">${snapshot.folders
          .map(
            (folder) =>
              `<option value="${escapeHtml(folder.uri)}" ${folder.active ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`
          )
          .join('')}</select></label>`
      : '';

  return `
    <a class="skip-link" href="#composer-field">Skip to composer</a>
    <div class="layout" data-testid="chat-app" data-ui-mode="${escapeHtml(snapshot.uiMode)}"${chatFontStyle(snapshot)}>
      <div class="header-summary visually-hidden" aria-label="Current chat summary">${escapeHtml(summaryLine)}</div>
      <div id="a11y-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>

      ${restrictedBanner}
      ${renderShareBar(snapshot)}
      ${renderRecovery(snapshot)}

      <main class="conversation" id="messages" role="log" aria-live="off" aria-relevant="additions text">${
        connecting && snapshot.messages.length === 0
          ? `<div class="connecting-state" role="status" aria-live="polite"><div class="boot-loader" aria-hidden="true"><svg class="boot-squiggle" viewBox="0 0 104 104" role="img"><path d="M 96.0 52.0 L 97.3 54.0 L 98.2 56.0 L 98.7 58.2 L 98.7 60.2 L 98.0 62.2 L 96.8 64.0 L 95.2 65.6 L 93.3 67.0 L 91.4 68.3 L 89.7 69.6 L 88.2 70.9 L 87.2 72.3 L 86.5 74.0 L 86.1 75.9 L 85.9 78.0 L 85.7 80.3 L 85.4 82.6 L 84.8 84.8 L 83.8 86.8 L 82.5 88.3 L 80.7 89.4 L 78.6 90.0 L 76.3 90.2 L 74.0 90.1 L 71.7 89.9 L 69.6 89.7 L 67.6 89.7 L 65.9 90.2 L 64.3 91.0 L 62.8 92.2 L 61.2 93.7 L 59.6 95.3 L 57.9 96.9 L 56.0 98.2 L 54.1 99.1 L 52.0 99.4 L 49.9 99.1 L 48.0 98.2 L 46.1 96.9 L 44.4 95.3 L 42.8 93.7 L 41.2 92.2 L 39.7 91.0 L 38.1 90.2 L 36.4 89.7 L 34.4 89.7 L 32.3 89.9 L 30.0 90.1 L 27.7 90.2 L 25.4 90.0 L 23.3 89.4 L 21.5 88.3 L 20.2 86.8 L 19.2 84.8 L 18.6 82.6 L 18.3 80.3 L 18.1 78.0 L 17.9 75.9 L 17.5 74.0 L 16.8 72.3 L 15.8 70.9 L 14.3 69.6 L 12.6 68.3 L 10.7 67.0 L 8.8 65.6 L 7.2 64.0 L 6.0 62.2 L 5.3 60.2 L 5.3 58.2 L 5.8 56.0 L 6.7 54.0 L 8.0 52.0 L 9.3 50.1 L 10.6 48.4 L 11.5 46.7 L 12.0 44.9 L 12.1 43.2 L 11.8 41.2 L 11.3 39.2 L 10.7 37.0 L 10.1 34.7 L 9.9 32.4 L 10.2 30.2 L 11.0 28.3 L 12.2 26.7 L 14.0 25.4 L 16.1 24.4 L 18.3 23.7 L 20.5 23.2 L 22.6 22.6 L 24.4 21.9 L 25.9 20.9 L 27.1 19.6 L 28.1 17.9 L 29.1 16.0 L 30.0 13.9 L 31.1 11.8 L 32.4 9.9 L 34.0 8.4 L 35.8 7.5 L 37.8 7.0 L 40.0 7.2 L 42.2 7.8 L 44.4 8.7 L 46.4 9.7 L 48.4 10.6 L 50.2 11.2 L 52.0 11.4 L 53.8 11.2 L 55.6 10.6 L 57.6 9.7 L 59.6 8.7 L 61.8 7.8 L 64.0 7.2 L 66.2 7.0 L 68.2 7.5 L 70.0 8.4 L 71.6 9.9 L 72.9 11.8 L 74.0 13.9 L 74.9 16.0 L 75.9 17.9 L 76.9 19.6 L 78.1 20.9 L 79.6 21.9 L 81.4 22.6 L 83.5 23.2 L 85.7 23.7 L 87.9 24.4 L 90.0 25.4 L 91.8 26.7 L 93.0 28.3 L 93.8 30.2 L 94.1 32.4 L 93.9 34.7 L 93.3 37.0 L 92.7 39.2 L 92.2 41.2 L 91.9 43.2 L 92.0 44.9 L 92.5 46.7 L 93.4 48.4 L 94.7 50.1 L 96.0 52.0 Z" fill="none" stroke="#ff8c42" stroke-width="2.5" stroke-linecap="round"/></svg><svg class="boot-pi" viewBox="0 0 24 24" role="img"><g fill="#ff8c42"><path d="M3.2 5.4 L20 5.4 L18.4 8 L4.8 8 Z"/><rect x="6.1" y="8" width="2.7" height="10.6" rx="1.1"/><path d="M14.4 8 h2.7 v8.4 l-2.7 2.2 Z"/><path d="M9.8 19.2 l2.1 -1.6 l-2.1 -1.6 v3.2 Z" opacity="0.9"/></g></svg></div><p class="connecting-copy">${
              snapshot.sessionFile
                ? 'Loading chat'
                : snapshot.connectionState === 'starting'
                  ? 'Starting π'
                  : 'Connecting to π'
            }<span class="loading-dots" aria-hidden="true"></span></p><p class="connecting-hint">First chat can take a few seconds while the agent warms up</p></div>`
          : faulted && snapshot.messages.length === 0
            ? `<div class="empty-state"><p class="empty-copy">Couldn’t start Pi for this workspace.</p><div class="button-row compact"><button type="button" data-command="piRpcInternal.restart">Try again</button><button type="button" data-command="piRpcInternal.showLogs">Show logs</button></div></div>`
            : renderMessages(snapshot)
      }<button type="button" id="jump-latest" class="jump-latest" title="Scroll to latest" aria-label="Scroll to latest message" hidden><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg></button></main>

      ${renderApprovals(snapshot)}
      <section class="composer-dock" aria-labelledby="composer-heading">
        <h2 id="composer-heading" class="visually-hidden">Message Pi</h2>
        <label class="visually-hidden" for="${COMPOSER_FIELD_ID}">Message π</label>
        ${
          attachmentsVisible
            ? `<div class="attachment-tray"><div class="section-label">Attachments for next message</div><div class="chip-list" role="list" aria-label="Attachments for next message">${snapshot.pendingContextItems
                .map((item) => renderContextChip(item))
                .join(
                  ''
                )}${renderImageChip(snapshot)}</div><button type="button" data-action="clearAttachments">Clear attachments</button></div>`
            : ''
        }
        ${renderQueueTray(snapshot)}
        ${busy ? renderWorkingBanner(snapshot) : ''}
        <div class="composer-card${connecting ? ' is-connecting' : ''}" aria-busy="${connecting ? 'true' : 'false'}">
          <textarea id="${COMPOSER_FIELD_ID}" rows="3" placeholder="${connecting ? 'Connecting to π…' : 'Ask π to edit…'}" ${disabledAttr}>${escapeHtml(snapshot.draft)}</textarea>
          <div class="composer-actions" aria-label="Composer actions">
            <div class="composer-actions-left">
              <button type="button" id="${ATTACH_TRIGGER_ID}" class="icon-button" data-action="appendPickedFile" title="Add a file" aria-label="Add a file" ${disabledAttr}>+</button>
              <button type="button" class="icon-button" data-command="piRpc.showPiCommands" title="Commands" aria-label="Commands" ${disabledAttr}>/</button>
            </div>
            <div class="composer-actions-right">
              ${connecting ? '' : folderSelect}
              ${connecting ? '' : renderModelControl(snapshot)}
              ${connecting ? '' : renderCostLabel(snapshot)}
              ${busy ? '<button type="button" class="ghost" data-action="abort">Stop</button>' : ''}
              <button type="button" id="${SEND_BUTTON_ID}" class="send-button" data-send-command="${sendCommand}" title="${sendLabel}" aria-label="${sendLabel}" ${disabledAttr}><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4v3a1.5 1.5 0 0 1-1.5 1.5H4.5"/><path d="M7 6L4.3 8.5 7 11"/></svg></button>
            </div>
          </div>
        </div>
      </section>

      ${renderPreview(snapshot)}
    </div>`;
}
