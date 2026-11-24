import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJob, canonicalModel, toFixed, fromFixed, costOf, quote, medianFixed, InputError } from '../src/core.mjs';

test('validateJob rejects bad shapes', () => {
  const bad = [
    null, {}, { model: '', inputTokens: 1, outputTokens: 1 },
    { model: 'a b', inputTokens: 1, outputTokens: 1 },
    { model: 'x'.repeat(121), inputTokens: 1, outputTokens: 1 },
    { model: 'm', inputTokens: -1, outputTokens: 1 },
    { model: 'm', inputTokens: 1.5, outputTokens: 1 },
    { model: 'm', inputTokens: 1, outputTokens: 1e10 },
    { model: 'm', inputTokens: '5', outputTokens: 1 },
    { model: 'm', inputTokens: 0, outputTokens: 0 },
  ];
  for (const j of bad) assert.throws(() => validateJob(j), InputError, JSON.stringify(j));
  assert.deepEqual(validateJob({ model: 'qwen/qwen3.8-27b', inputTokens: 0, outputTokens: 1 }).outputTokens, 1);
});

test('canonicalModel strips org and variant suffixes but keeps them visible', () => {
  assert.deepEqual(canonicalModel('Qwen/Qwen3.8-27B-TEE'), { key: 'qwen3.8-27b', variant: ['tee'] });
  assert.deepEqual(canonicalModel('qwen/qwen3.8-27b:batch'), { key: 'qwen3.8-27b', variant: ['batch'] });
  assert.deepEqual(canonicalModel('qwen/qwen3-coder-30b-a3b-instruct-fp8'), { key: 'qwen3-coder-30b-a3b-instruct', variant: ['fp8'] });
  assert.equal(canonicalModel('qwen/qwen3-14b').key, 'qwen3-14b');
});

test('fixed-point is exact where floats are not', () => {
  assert.equal(0.0000005 * 2 * 1e6 === 1, true); // happens to round right
  assert.equal(fromFixed(toFixed('0.1') + toFixed('0.2')), '0.3'); // 0.1+0.2 float = 0.30000000000000004
  assert.equal(fromFixed(toFixed(1e-7), 12), '0.0000001');
  assert.equal(toFixed('1e-7'), null); // exponent strings are refused, not misparsed
  assert.equal(toFixed('abc'), null);
  assert.equal(fromFixed(medianFixed(['3', '1', '2'])), '2');
  assert.equal(fromFixed(medianFixed(['1', '2'])), '1.5');
  assert.equal(medianFixed([]), null);
});

test('costOf: unknown or negative price on a used leg is null, unused leg ignored', () => {
  const job = { inputTokens: 1_000_000, outputTokens: 500_000 };
  assert.equal(fromFixed(costOf({ inPer1M: '0.1', outPer1M: '2' }, job)), '1.1');
  assert.equal(costOf({ inPer1M: null, outPer1M: '2' }, job), null);
  assert.equal(costOf({ inPer1M: '-1', outPer1M: '2' }, job), null);
  assert.equal(fromFixed(costOf({ inPer1M: null, outPer1M: '2' }, { inputTokens: 0, outputTokens: 1_000_000 })), '2');
});

test('quote ranks USD routes, keeps FLOP separate, converts only with a cited rate', () => {
  const offers = [
    { provider: 'a', model: 'org/m-1', unit: 'USD', inPer1M: '1', outPer1M: '1', source: 's' },
    { provider: 'b', model: 'M-1-TEE', unit: 'USD', inPer1M: '0.5', outPer1M: '0.5', source: 's' },
    { provider: 'f', model: 'x/m-1', unit: 'FLOP', inPer1M: '10', outPer1M: '10', source: 's' },
    { provider: 'z', model: 'other', unit: 'USD', inPer1M: '0', outPer1M: '0', source: 's' },
  ];
  const job = { model: 'm-1', inputTokens: 1_000_000, outputTokens: 0 };
  const q = quote(offers, job);
  assert.equal(q.matched, 3);
  assert.equal(q.cheapestUsd.provider, 'b');
  assert.deepEqual(q.cheapestUsd.variant, ['tee']);
  assert.equal(q.noUsdPrice.length, 1);
  assert.equal(q.noUsdPrice[0].cost, '10');
  assert.equal(q.noUsdPrice[0].costUsd, null);
  const q2 = quote(offers, job, { FLOP: { usd: '0.01', source: 'test-feed' } });
  assert.equal(q2.cheapestUsd.provider, 'f');
  assert.equal(q2.cheapestUsd.costUsd, '0.1');
  assert.match(q2.cheapestUsd.usdBasis, /test-feed/);
  assert.throws(() => quote(offers, { model: 'm-1', inputTokens: 0, outputTokens: 0 }), InputError);
});

test('JSON numbers in exponent form convert exactly', () => {
  assert.equal(fromFixed(toFixed(2.1233006109116963e-4), 24), '0.00021233006109116963');
  assert.equal(fromFixed(toFixed(1.5e21), 0), '1500000000000000000000');
  assert.equal(fromFixed(toFixed(-3e-7), 12), '-0.0000003');
});
