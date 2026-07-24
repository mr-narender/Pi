import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toWsBase, hostWsUrl, pairingLink, httpBase } from '../../src/remote/remoteConfig';

test('toWsBase switches scheme and trims', () => {
  assert.equal(toWsBase('https://pi.fromlab.work/'), 'wss://pi.fromlab.work');
  assert.equal(toWsBase('http://localhost:8000'), 'ws://localhost:8000');
  assert.equal(toWsBase('pi.fromlab.work'), 'wss://pi.fromlab.work');
});
test('hostWsUrl + pairingLink', () => {
  assert.equal(
    hostWsUrl('http://localhost:8000', 'sid 1', 'tok/2'),
    'ws://localhost:8000/host?session=sid%201&token=tok%2F2'
  );
  assert.equal(
    pairingLink('https://pi.fromlab.work/', 'ABC123'),
    'https://pi.fromlab.work/p#ABC123'
  );
  assert.equal(httpBase('https://x/'), 'https://x');
});
