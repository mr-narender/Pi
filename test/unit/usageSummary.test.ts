import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeUsage, formatTokens, formatUsageChip } from '../../src/webview/usageSummary';

test('summarizeUsage extracts tokens/context/cost; undefined when empty', () => {
  const u = summarizeUsage({
    tokens: { total: 12345, input: 10000, output: 2345 },
    contextUsage: { tokens: 12345, contextWindow: 200000, percent: 6 },
    cost: 0.0234,
  });
  assert.deepEqual(u, { totalTokens: 12345, contextPercent: 6, cost: 0.0234 });
  assert.equal(summarizeUsage(undefined), undefined);
  assert.equal(summarizeUsage({}), undefined);
});

test('formatTokens and chip label', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12345), '12k');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(2_500_000), '2.5M');
  assert.equal(
    formatUsageChip({ totalTokens: 12345, contextPercent: 6, cost: 0.0234 }),
    '6% · 12k tok · $0.023'
  );
  assert.equal(formatUsageChip({ totalTokens: 0 }), '');
});
