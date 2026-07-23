import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationToMarkdown } from '../../src/webview/conversationMarkdown';

test('conversationToMarkdown renders user/agent/thinking/tool/result to markdown', () => {
  const md = conversationToMarkdown(
    [
      { id: 'u', role: 'user', text: 'Fix auth', attachments: [] },
      {
        id: 'a',
        role: 'assistant',
        text: '',
        blocks: [
          { kind: 'thinking', text: 'reason' },
          { kind: 'tool', name: 'bash', args: '{"cmd":"ls"}' },
          { kind: 'text', text: 'Done. See `parseToken`.' },
        ],
        attachments: [],
      },
      { id: 'r', role: 'toolResult', text: 'file.txt', attachments: [] },
    ],
    'My Chat'
  );
  assert.match(md, /^# My Chat/);
  assert.match(md, /\*\*You:\*\*\n\nFix auth/);
  assert.match(md, /> _Thinking:_ reason/);
  assert.match(md, /\*\*Tool\*\* `bash`/);
  assert.match(md, /\*\*Result:\*\*\n\n```\nfile\.txt\n```/);
  assert.match(md, /Done\. See `parseToken`\./);
});
