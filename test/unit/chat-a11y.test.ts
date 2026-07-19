import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACH_TRIGGER_ID,
  COMPOSER_FIELD_ID,
  PREVIEW_ACCEPT_BUTTON_ID,
  PREVIEW_CANCEL_BUTTON_ID,
  contextChipRemoveButtonId,
  focusTargetFromSnapshot,
  imageChipRemoveButtonId,
  nextPreviewTrapTarget,
  planChipRemovalFocus,
  shouldClearSnapshotFocus,
} from '../../src/webview/render';
import type { WebviewSnapshot } from '../../src/state/types';

function snapshot(overrides: Partial<WebviewSnapshot> = {}): WebviewSnapshot {
  return {
    sequence: 1,
    title: 'Current Chat',
    uiMode: 'simple',
    connectionState: 'ready',
    workspaceFolderName: 'workspace',
    sessionName: 'Demo Session',
    sessionId: 'sid',
    sessionFile: '/tmp/workspace/session.jsonl',
    isStreaming: false,
    isCompacting: false,
    messageCount: 0,
    pendingMessageCount: 0,
    messages: [],
    queue: { steering: [], followUp: [] },
    draft: 'draft',
    statuses: {},
    widgets: [],
    model: { provider: 'mock', id: 'model' },
    thinkingLevel: 'medium',
    pendingContextItems: [],
    pendingImages: [],
    focus: 'composer',
    isTrusted: true,
    folders: [{ name: 'workspace', uri: 'file:///tmp/workspace', active: true }],
    ...overrides,
  };
}

test('focusTargetFromSnapshot routes preview, chip, attach, and composer focus deterministically', () => {
  assert.equal(
    focusTargetFromSnapshot(
      snapshot({
        preview: { command: 'prompt', draft: '', rpcMessage: 'x', rpcImages: [], imageItems: [] },
      })
    ),
    PREVIEW_ACCEPT_BUTTON_ID
  );
  assert.equal(focusTargetFromSnapshot(snapshot({ focus: 'attach' })), ATTACH_TRIGGER_ID);
  assert.equal(
    focusTargetFromSnapshot(
      snapshot({
        focus: 'contextChip',
        pendingContextItems: [
          {
            kind: 'activeFile',
            itemId: 'ctx-1',
            workspaceFolder: '/tmp/workspace',
            workspaceRelativePath: 'src/app.ts',
            lineStart: 1,
            lineEnd: 2,
            languageId: 'typescript',
            sanitizedContent: 'const a = 1;',
            capturedAt: '2024-01-01T00:00:00.000Z',
            persistedRef: {
              workspaceRelativePath: 'src/app.ts',
              lineStart: 1,
              lineEnd: 2,
              languageId: 'typescript',
              contentFingerprint: 'abc',
            },
          },
        ],
      })
    ),
    contextChipRemoveButtonId('ctx-1')
  );
  assert.equal(
    focusTargetFromSnapshot(
      snapshot({
        focus: 'imageChip',
        pendingImages: [
          {
            itemId: 'img-1',
            name: 'diagram.png',
            mimeType: 'image/png',
            sizeBytes: 42,
          },
        ],
      })
    ),
    imageChipRemoveButtonId('img-1')
  );
  assert.equal(focusTargetFromSnapshot(snapshot({ focus: 'none' })), undefined);
  assert.equal(focusTargetFromSnapshot(snapshot()), COMPOSER_FIELD_ID);
});

test('planChipRemovalFocus prefers next chip, then previous chip, then Attach', () => {
  const state = snapshot({
    pendingContextItems: [
      {
        kind: 'activeFile',
        itemId: 'ctx-1',
        workspaceFolder: '/tmp/workspace',
        workspaceRelativePath: 'src/a.ts',
        lineStart: 1,
        lineEnd: 2,
        languageId: 'typescript',
        sanitizedContent: 'a',
        capturedAt: '2024-01-01T00:00:00.000Z',
        persistedRef: {
          workspaceRelativePath: 'src/a.ts',
          lineStart: 1,
          lineEnd: 2,
          languageId: 'typescript',
          contentFingerprint: 'a',
        },
      },
      {
        kind: 'selection',
        itemId: 'ctx-2',
        workspaceFolder: '/tmp/workspace',
        workspaceRelativePath: 'src/b.ts',
        lineStart: 3,
        lineEnd: 4,
        languageId: 'typescript',
        sanitizedContent: 'b',
        capturedAt: '2024-01-01T00:00:00.000Z',
        persistedRef: {
          workspaceRelativePath: 'src/b.ts',
          lineStart: 3,
          lineEnd: 4,
          languageId: 'typescript',
          contentFingerprint: 'b',
        },
      },
    ],
    pendingImages: [
      {
        itemId: 'img-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        sizeBytes: 42,
      },
    ],
  });

  assert.deepEqual(planChipRemovalFocus(state, 'ctx-1'), {
    targetId: contextChipRemoveButtonId('ctx-2'),
    fallbackId: ATTACH_TRIGGER_ID,
  });
  assert.deepEqual(planChipRemovalFocus(state, 'ctx-2'), {
    targetId: imageChipRemoveButtonId('img-1'),
    fallbackId: ATTACH_TRIGGER_ID,
  });
  assert.deepEqual(
    planChipRemovalFocus(snapshot({ pendingImages: state.pendingImages }), 'img-1'),
    {
      fallbackId: ATTACH_TRIGGER_ID,
    }
  );
});

test('nextPreviewTrapTarget wraps among preview actions for Tab and Shift+Tab', () => {
  assert.equal(nextPreviewTrapTarget(undefined), PREVIEW_ACCEPT_BUTTON_ID);
  assert.equal(nextPreviewTrapTarget(undefined, true), PREVIEW_CANCEL_BUTTON_ID);
  assert.equal(nextPreviewTrapTarget(PREVIEW_ACCEPT_BUTTON_ID), PREVIEW_CANCEL_BUTTON_ID);
  assert.equal(nextPreviewTrapTarget(PREVIEW_CANCEL_BUTTON_ID), PREVIEW_ACCEPT_BUTTON_ID);
  assert.equal(nextPreviewTrapTarget(PREVIEW_ACCEPT_BUTTON_ID, true), PREVIEW_CANCEL_BUTTON_ID);
});

test('shouldClearSnapshotFocus marks transient preview and chip targets only', () => {
  assert.equal(shouldClearSnapshotFocus('preview'), true);
  assert.equal(shouldClearSnapshotFocus('contextChip'), true);
  assert.equal(shouldClearSnapshotFocus('imageChip'), true);
  assert.equal(shouldClearSnapshotFocus('attach'), false);
  assert.equal(shouldClearSnapshotFocus('composer'), false);
});
