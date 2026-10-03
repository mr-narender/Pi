import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendlyApiStatus, parseProviderError } from '../../src/webview/apiError';

test('parses the exact Anthropic rate-limit error reported by the user', () => {
  const raw =
    'anthropic/claude-fable-5 failed: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CfSq4KRAhpUR5eT2NKmrR"}';
  const parsed = parseProviderError(raw);
  assert.equal(parsed.provider, 'anthropic');
  assert.equal(parsed.model, 'claude-fable-5');
  assert.equal(parsed.statusCode, 429);
  assert.equal(parsed.errorType, 'rate_limit_error');
  assert.equal(
    parsed.message,
    "This request would exceed your account's rate limit. Please try again later."
  );
  assert.equal(parsed.requestId, 'req_011CfSq4KRAhpUR5eT2NKmrR');
  const status = friendlyApiStatus(parsed.statusCode, parsed.errorType);
  assert.deepEqual(status, { label: 'Rate Limited', severity: 'warning' });
});

test('parses an OpenAI-shaped error body without a top-level request_id', () => {
  const raw =
    'openai/gpt-6 failed: 401 {"error":{"message":"Invalid API key","type":"authentication_error","code":"invalid_api_key"}}';
  const parsed = parseProviderError(raw);
  assert.equal(parsed.provider, 'openai');
  assert.equal(parsed.statusCode, 401);
  assert.equal(parsed.errorType, 'authentication_error');
  assert.equal(parsed.message, 'Invalid API key');
  assert.equal(parsed.requestId, undefined);
  assert.deepEqual(friendlyApiStatus(401, 'authentication_error'), {
    label: 'Authentication Error',
    severity: 'error',
  });
});

test('malformed JSON body degrades to the plain-text remainder, never throws', () => {
  const raw = 'anthropic/claude-fable-5 failed: 500 { not valid json at all';
  const parsed = parseProviderError(raw);
  assert.equal(parsed.statusCode, 500);
  assert.ok(parsed.message.length > 0);
  assert.equal(parsed.raw, raw);
});

test('completely unstructured message falls back to raw, never crashes', () => {
  const raw = 'connection reset by peer';
  const parsed = parseProviderError(raw);
  assert.equal(parsed.message, raw);
  assert.equal(parsed.provider, undefined);
  assert.equal(parsed.statusCode, undefined);
  assert.deepEqual(friendlyApiStatus(undefined, undefined), { label: 'Error', severity: 'error' });
});

test('friendlyApiStatus covers overload/server/not-found', () => {
  assert.equal(friendlyApiStatus(529, 'overloaded_error').label, 'Overloaded');
  assert.equal(friendlyApiStatus(503, undefined).severity, 'warning');
  assert.equal(friendlyApiStatus(500, undefined).label, 'Server Error');
  assert.equal(friendlyApiStatus(404, 'not_found_error').label, 'Not Found');
});
