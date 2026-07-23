import type { WebviewMessageBlock, WebviewMessageItem } from '../state/types';

function fence(text: string): string {
  return '```\n' + text.replace(/\r?\n$/, '') + '\n```';
}

function blockToMarkdown(block: WebviewMessageBlock): string {
  switch (block.kind) {
    case 'text':
      return block.text.trim();
    case 'thinking':
      return `> _Thinking:_ ${block.text.trim().replace(/\n/g, '\n> ')}`;
    case 'tool':
      return `**Tool** \`${block.name}\`${block.args ? `\n${fence(block.args)}` : ''}`;
    case 'toolResult':
      return `**${block.isError ? 'Tool error' : 'Tool result'}**\n${fence(block.text)}`;
    case 'image':
      return `_[image: ${block.mimeType}]_`;
    default:
      return '';
  }
}

/** Render a conversation (webview message items) to portable Markdown. */
export function conversationToMarkdown(
  messages: readonly WebviewMessageItem[],
  title?: string
): string {
  const out: string[] = [];
  if (title && title.trim()) {
    out.push(`# ${title.trim()}`, '');
  }
  for (const message of messages) {
    const role = message.role;
    if (role === 'user') {
      out.push('**You:**', '', message.text.trim(), '');
      continue;
    }
    if (role === 'assistant') {
      const blocks: WebviewMessageBlock[] =
        message.blocks && message.blocks.length > 0
          ? message.blocks
          : message.text
            ? [{ kind: 'text', text: message.text }]
            : [];
      const body = blocks
        .map(blockToMarkdown)
        .filter((part) => part.length > 0)
        .join('\n\n');
      out.push('**Pi:**', '', body, '');
      continue;
    }
    if (role === 'toolResult' || role === 'tool' || role === 'bashExecution') {
      out.push('**Result:**', '', fence(message.text), '');
      continue;
    }
    out.push(`**${role}:**`, '', message.text.trim(), '');
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}
