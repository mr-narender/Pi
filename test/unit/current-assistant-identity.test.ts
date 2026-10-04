import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInitialControllerState } from '../../src/state/types';
import { reduceEvent, resetControllerProjection } from '../../src/state/reducer';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { renderChatApp } from '../../src/webview/render';

for (const user of [false, true]) {
  test(`native current identity preserves empty history, user=${user}`, () => {
    let state = createInitialControllerState('workspace', '/tmp/owned');
    state.connectionState = 'ready';
    state.messages = [{ id: 'history', role: 'assistant', content: [] }];
    const dom = new JSDOM('<main></main>');
    const root = dom.window.document.querySelector('main')!;
    const project = () =>
      createWebviewSnapshot(state, 1, {
        composer: createEmptyComposerState(),
        isTrusted: true,
        folders: [],
      });
    const render = () => {
      root.innerHTML = renderChatApp(project());
    };
    const history = () =>
      assert.ok(
        root.querySelector('[data-mid="history"] [data-command="piRpcInternal.retryLast"]')
      );
    render();
    history();
    state = reduceEvent(state, { type: 'agent_start' });
    render();
    history();
    if (user)
      state = reduceEvent(state, {
        type: 'message_start',
        message: { id: 'u', role: 'user', content: 'again' },
      });
    state = reduceEvent(state, {
      type: 'message_start',
      message: { id: 'new', role: 'assistant', content: [] },
    });
    render();
    history();
    assert.equal(root.querySelector('[data-mid="new"]'), null);
    assert.equal(project().currentAssistantMessageId, 'new');
    for (const invalid of [
      { generation: state.generation + 1 },
      { switchingSession: true },
      { state: { sessionFile: 'other' } },
    ]) {
      assert.equal(
        createWebviewSnapshot({ ...state, ...invalid }, 1, {
          composer: createEmptyComposerState(),
          isTrusted: true,
          folders: [],
        }).currentAssistantMessageId,
        undefined
      );
    }
    assert.equal(resetControllerProjection(state).currentAssistant, undefined);
    root.innerHTML = renderChatApp({ ...project(), bindingState: 'cached' });
    assert.ok(root.querySelector('[data-mid="new"] .assistant-empty'));
    state = reduceEvent(state, {
      type: 'message_update',
      message: { id: 'new', role: 'assistant', content: [], errorMessage: 'provider failed' },
    });
    render();
    history();
    assert.match(root.textContent!, /provider failed/);
    state = reduceEvent(state, {
      type: 'message_end',
      message: { id: 'new', role: 'assistant', content: [] },
    });
    render();
    assert.ok(root.querySelector('[data-mid="new"] .assistant-empty'));
    state = reduceEvent(state, { type: 'agent_end' });
    state = reduceEvent(state, { type: 'agent_start' });
    render();
    history();
    assert.ok(root.querySelector('[data-mid="new"] .assistant-empty'));
    assert.equal(state.messages.length, user ? 3 : 2);
    // Actual native messages may have timestamp identity rather than an id.
    state = reduceEvent(state, {
      type: 'message_start',
      message: { role: 'assistant', timestamp: 123, content: [] },
    });
    const anonymousId = project().currentAssistantMessageId!;
    render();
    assert.equal(root.querySelector(`[data-mid="${anonymousId}"]`), null);
    state = reduceEvent(state, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'P' },
    });
    assert.equal(project().currentAssistantMessageId, anonymousId);
    render();
    assert.equal(root.querySelector('.js-stream-text')?.getAttribute('data-raw'), 'P');
    state = reduceEvent(state, { type: 'turn_end' });
    assert.equal(project().currentAssistantMessageId, undefined);
    dom.window.close();
  });
}
