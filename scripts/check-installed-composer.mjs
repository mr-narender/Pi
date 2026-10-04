import assert from 'node:assert/strict';

// Read-only geometry check against a caller-owned, normal installed VS Code.
// Native CDP handles Electron's cross-process webviews without a browser dependency.
const endpoint = process.argv[2];
assert.ok(endpoint, 'Usage: node scripts/check-installed-composer.mjs http://127.0.0.1:PORT');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname));
const targets = await (
  await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(3000) })
).json();
assert.ok(
  targets.some(
    (target) => target.type === 'page' && target.url.startsWith('vscode-file://vscode-app/')
  ),
  'Expected a real VS Code workbench'
);
const measurements = [];
for (const target of targets) {
  if (target.type !== 'iframe' || !target.url.includes('extensionId=mr-narender.pi')) continue;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('CDP connection timed out'));
    }, 3000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      (error) => {
        clearTimeout(timer);
        socket.close();
        reject(error);
      },
      { once: true }
    );
  });
  let sequence = 0;
  const pending = new Map();
  const contexts = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') contexts.push(message.params.context);
    if (message.id) {
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message);
      }
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    await send('Runtime.enable');
    for (const context of contexts.filter((item) => item.auxData?.isDefault)) {
      const result = await send('Runtime.evaluate', {
        contextId: context.id,
        returnByValue: true,
        expression: `(() => {
          if (!document.querySelector('#composer-send-button')) return null;
          const rect = (element) => { const r = element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
          return {viewport:innerWidth,height:innerHeight,card:rect(document.querySelector('.composer-card')),controls:[...document.querySelectorAll('.composer-actions button')].filter(x=>getComputedStyle(x).display!=='none'&&getComputedStyle(x).visibility!=='hidden').map(x=>({id:x.id,label:x.getAttribute('aria-label')||x.id,disabled:x.disabled,...rect(x)}))};
        })()`,
      });
      assert.ok(!result.result?.exceptionDetails, 'Geometry evaluation must succeed');
      const geometry = result.result?.result?.value;
      if (!geometry) continue;
      assert.ok(
        geometry.controls.some((control) => control.id === 'composer-send-button'),
        'Send must be visible'
      );
      assert.ok(geometry.controls.length >= 6, 'Expected all six controls of the ready composer');
      for (const control of geometry.controls) {
        assert.ok(
          control.width > 0 && control.height > 0,
          `${control.label} must have visible dimensions`
        );
        assert.ok(
          control.left >= 0 &&
            control.right <= geometry.viewport + 0.5 &&
            control.top >= 0 &&
            control.bottom <= geometry.height + 0.5,
          `${control.label} is outside the viewport: ${JSON.stringify(geometry)}`
        );
        assert.ok(
          control.left >= geometry.card.left - 0.5 && control.right <= geometry.card.right + 0.5,
          `${control.label} overflows the composer card`
        );
      }
      for (let left = 0; left < geometry.controls.length; left++) {
        for (let right = left + 1; right < geometry.controls.length; right++) {
          const a = geometry.controls[left],
            b = geometry.controls[right];
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          assert.ok(overlapX <= 0.5 || overlapY <= 0.5, `${a.label} overlaps ${b.label}`);
        }
      }
      measurements.push(geometry);
    }
  } finally {
    socket.close();
  }
}
assert.ok(measurements.length, 'Expected at least one actual installed composer');
console.log(JSON.stringify({ result: 'PASS', measurements }));
