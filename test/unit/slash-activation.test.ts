import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = build({
  entryPoints: ['src/webview/media/chat.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
for (const activation of ['click', 'Enter', 'Tab', 'typed'] as const) {
  test(`core menu ${activation} consumes immediately and dispatches once`, async () => {
    const dom = new JSDOM('<div id="app"></div>', {
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const w = dom.window;
    const posted: any[] = [];
    Object.assign(w, {
      acquireVsCodeApi: () => ({
        postMessage: (m: any) => posted.push(m),
        getState() {},
        setState() {},
      }),
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IntersectionObserver: class {
        observe() {}
        disconnect() {}
      },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    });
    w.HTMLElement.prototype.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = () => {};
    try {
      w.eval((await bundle).outputFiles[0]!.text);
      const snapshot = {
        sequence: 1,
        title: 'Chat',
        bindingState: 'current',
        uiMode: 'simple',
        connectionState: 'ready',
        sessionId: 'sid',
        messages: [],
        queue: { steering: [], followUp: [] },
        draft: '',
        statuses: {},
        widgets: [],
        pendingContextItems: [],
        pendingImages: [{ itemId: 'img', name: 'kept.png', mimeType: 'image/png', sizeBytes: 1 }],
        isTrusted: true,
        folders: [],
      };
      const send = (extra: any = {}) =>
        w.dispatchEvent(
          new w.MessageEvent('message', {
            data: { type: 'snapshot', snapshot: { ...snapshot, ...extra } },
          })
        );
      send();
      w.dispatchEvent(
        new w.MessageEvent('message', {
          data: { type: 'slashCommands', items: [{ name: 'model', description: 'Select model' }] },
        })
      );
      const field = () => w.document.querySelector('textarea')!;
      field().focus();
      field().value = activation === 'typed' ? '/model' : '/mo';
      field().dispatchEvent(new w.Event('input', { bubbles: true }));
      field().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      assert.equal(posted.filter((m) => m.type === 'requestSend').length, 0);
      if (activation === 'click')
        w.document
          .querySelector('.slash-item')!
          .dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      else
        field().dispatchEvent(
          new w.KeyboardEvent('keydown', {
            key: activation === 'Tab' ? 'Tab' : 'Enter',
            bubbles: true,
            cancelable: true,
          })
        );
      assert.equal(
        posted.filter((m) => m.type === 'requestSend').length,
        1,
        'activation must invoke, not merely complete'
      );
      assert.equal(field().value, '', 'consume before picker result');
      const id = posted.find((m) => m.type === 'requestSend').submissionId;
      send({ draft: '/model', sequence: 2 });
      assert.equal(field().value, '', 'stale draft echo cannot restore consumed input');
      field().value = 'new draft';
      field().dispatchEvent(new w.Event('input', { bubbles: true }));
      field().blur();
      send({ draft: '', composerResetSeq: 1, localCommandAck: id, pendingImages: [] });
      assert.equal(field().value, 'new draft');
      assert.match(w.document.body.textContent!, /kept.png/);
    } finally {
      w.close();
    }
  });
}
