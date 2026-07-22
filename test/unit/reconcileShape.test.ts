import test from 'node:test';
import assert from 'node:assert/strict';
import { describeShape, extractMessageArray } from '../../src/sessions/reconcileShape';

test('extractMessageArray reads the documented messages key', () => {
  const msgs = [{ id: 'a', role: 'user' }];
  assert.deepEqual(extractMessageArray({ messages: msgs }), msgs);
});

test('extractMessageArray tolerates shape drift (bare array / alternate keys)', () => {
  const msgs = [{ id: 'a' }];
  assert.deepEqual(extractMessageArray(msgs), msgs);
  assert.deepEqual(extractMessageArray({ items: msgs }), msgs);
  assert.deepEqual(extractMessageArray({ transcript: msgs }), msgs);
});

test('extractMessageArray returns [] for empty/missing/wrong payloads', () => {
  assert.deepEqual(extractMessageArray({ messages: [] }), []);
  assert.deepEqual(extractMessageArray(undefined), []);
  assert.deepEqual(extractMessageArray(null), []);
  assert.deepEqual(extractMessageArray({ nope: 1 }), []);
});

test('describeShape summarizes payloads for logs', () => {
  assert.equal(describeShape({ messages: [1, 2, 3] }), 'object{messages:array[3]}');
  assert.equal(describeShape([1, 2]), 'array[2]');
  assert.equal(
    describeShape({ leafId: 'x', messages: [] }),
    'object{leafId:string,messages:array[0]}'
  );
  assert.equal(describeShape(null), 'null');
  assert.equal(describeShape(undefined), 'undefined');
});
