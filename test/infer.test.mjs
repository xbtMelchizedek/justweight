import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { infer, validateInfer, route, verifyReceipts, canonicalJson, Ledger, HARD_CALL_CAP_USD } from '../src/infer.mjs';
import { makeServer } from '../src/mcp.mjs';
import { toFixed } from '../src/core.mjs';

const P = (provider, model, inP, outP, extra = {}) => ({ provider, model, unit: 'USD', inPer1M: inP, outPer1M: outP, source: `https://x/${provider}`, ...extra });
const ZDR = { privacy: { noRetention: true, tee: false, e2ee: false, local: false } };
const SNAP = {
  generatedAt: '2026-11-24T19:00:00.000Z',
  offers: [
    P('openrouter:cheap/fp8', 'qwen/qwen3.8-27b:fp8', '0.04', '1.2', { latencyP50Ms: 900, privacy: { noRetention: false, tee: false, e2ee: false, local: false } }),
    P('openrouter:zdr/fp8', 'qwen/qwen3.8-27b:fp8', '0.06', '1.9', { latencyP50Ms: 300, ...ZDR }),
    P('chutes-bittensor', 'Qwen/Qwen3.8-27B-TEE', '0.039', '1.25', { privacy: { noRetention: false, tee: true, e2ee: false, local: false } }),
    P('venice', 'qwen/qwen3.8-27b', '0.45', '3.2', ZDR),
    P('pearl-labs', 'Qwen/Qwen3.8-27B', '0.1', '2'), // no privacy info: excluded from any privacy filter
    { provider: 'flop-gateway', model: 'qwen/qwen3.8-27b', unit: 'FLOP', inPer1M: '1', outPer1M: '1', source: 'f' },
    { provider: 'local', model: 'thinkingmachines/inkling-2-mini', unit: 'LOCAL', inPer1M: '0', outPer1M: '0', source: 'l', privacy: { noRetention: true, tee: false, e2ee: false, local: true } },
    P('openrouter:primeintellect/flex', 'thinkingmachines/inkling-2-mini:fp4', '0.0375', '0.15', ZDR),
  ],
};
const tmp = () => mkdtempSync(join(tmpdir(), 'jw-'));
const loader = () => {
  const f = async () => { f.calls++; return SNAP; };
  f.calls = 0;
  return f;
};
const base = { tier: 'mid', prompt: 'x'.repeat(3000), budget: 1000, max_usd: '0.01' };

test('validation rejects bad input before any I/O (T1)', async () => {
  const bad = [
    {},
    { ...base, tier: 'huge' },
    { ...base, model: 'qwen/qwen3.8-27b' }, // both tier and model
    { ...base, prompt: '' },
    { ...base, budget: 0 },
    { ...base, budget: 1.5 },
    { ...base, max_usd: '-1' },
    { ...base, max_usd: '1e3' },
    { ...base, max_usd: '0.51' }, // over the hard per-call cap
    { ...base, privacy: 'kinda' },
    { ...base, mode: 'yolo' },
  ];
  for (const a of bad) {
    const load = loader();
    await assert.rejects(infer(a, { load, ledgerDir: tmp(), env: {} }), { name: 'InputError' }, JSON.stringify(a).slice(0, 80));
    assert.equal(load.calls, 0);
  }
  assert.throws(() => validateInfer(base, { JUSTWEIGHT_DAILY_CAP_USD: '6' }), /at most 5/);
  assert.equal(HARD_CALL_CAP_USD, '0.50');
});

test('quote mode: cheapest route, nothing charged, receipt hashed and chained', async () => {
  const dir = tmp();
  const r = await infer(base, { load: loader(), ledgerDir: dir, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.output, null);
  // 3000 bytes -> 1000 input tokens est; 1000*0.04/1e6 + 1000*1.2/1e6 = 0.00124, under chutes' 0.001289
  assert.equal(r.receipt.route.provider, 'openrouter:cheap/fp8');
  assert.equal(r.receipt.cost.quotedUsd, '0.00124');
  assert.equal(r.alternatives[0].provider, 'chutes-bittensor');
  assert.equal(r.receipt.cost.chargedUsd, '0');
  assert.equal(r.receipt.status, 'quoted');
  assert.equal(r.receipt.prev, null);
  assert.ok(r.skipped.some((s) => /FLOP has no USD price/.test(s.reason)));
  const r2 = await infer({ ...base, privacy: 'no-retention' }, { load: loader(), ledgerDir: dir, env: {} });
  assert.equal(r2.receipt.prev, r.receipt.hash);
  const all = new Ledger(dir).all();
  assert.equal(verifyReceipts(all), -1);
  assert.equal(statSync(join(dir, 'receipts.jsonl')).mode & 0o777, 0o600);
  assert.equal(r.receipt.request.promptSha256.length, 64);
  assert.ok(!readFileSync(join(dir, 'receipts.jsonl'), 'utf8').includes('xxxxxxxx'), 'prompt text never stored');
});

test('privacy filters fail closed on unknown policy', async () => {
  const q = (privacy) => infer({ ...base, privacy }, { load: loader(), ledgerDir: tmp(), env: {} });
  assert.equal((await q('no-retention')).receipt.route.provider, 'openrouter:zdr/fp8');
  assert.equal((await q('tee')).receipt.route.provider, 'chutes-bittensor');
  const local = await q('local');
  assert.equal(local.ok, false, 'no local qwen');
  assert.ok(local.skipped.some((s) => s.route.startsWith('pearl-labs') && /privacy/.test(s.reason)));
  const ink = await infer({ ...base, tier: 'mini', privacy: 'local' }, { load: loader(), ledgerDir: tmp(), env: {} });
  assert.equal(ink.receipt.route.provider, 'local');
  assert.equal(ink.receipt.cost.quotedUsd, '0');
});

test('caps: per-call max_usd and the daily cap both exclude routes', () => {
  const req = validateInfer({ ...base, max_usd: '0.001' }, {});
  const r = route(SNAP.offers, req);
  assert.equal(r.chosen, null);
  assert.ok(r.skipped.filter((s) => /over max_usd/.test(s.reason)).length >= 4);
  const req2 = validateInfer(base, { JUSTWEIGHT_DAILY_CAP_USD: '1' });
  const r2 = route(SNAP.offers, req2, toFixed('0.9995'));
  assert.equal(r2.chosen, null);
  assert.ok(r2.skipped.some((s) => /daily cap left/.test(s.reason)));
  // The refusal is still a receipt.
});

test('live mode refuses paid venues; runs only a local model on loopback', async () => {
  const dir = tmp();
  const paid = await infer({ ...base, mode: 'live' }, { load: loader(), ledgerDir: dir, env: { JUSTWEIGHT_LOCAL_MODEL: 'inkling2-mini' }, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(paid.ok, false);
  assert.equal(paid.receipt.status, 'refused');
  assert.match(paid.receipt.reason, /quote-only/);
  for (const url of ['https://api.openrouter.ai/v1', 'http://10.0.0.5:11434/v1', 'http://user:pw@127.0.0.1:11434/v1', 'http://127.0.0.1.evil.com/v1']) {
    const load = loader();
    await assert.rejects(infer({ ...base, tier: 'mini', privacy: 'local', mode: 'live' }, { load, ledgerDir: dir, env: { JUSTWEIGHT_LOCAL_URL: url, JUSTWEIGHT_LOCAL_MODEL: 'm' } }), /JUSTWEIGHT_LOCAL_URL/);
    assert.equal(load.calls, 0, url);
  }
  await assert.rejects(infer({ ...base, tier: 'mini', privacy: 'local', mode: 'live' }, { load: loader(), ledgerDir: dir, env: {} }), /JUSTWEIGHT_LOCAL_MODEL/);
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 12, completion_tokens: 2 } }), { status: 200 });
  };
  const ok = await infer({ ...base, tier: 'mini', privacy: 'local', mode: 'live' }, { load: loader(), ledgerDir: dir, env: { JUSTWEIGHT_LOCAL_MODEL: 'inkling2-mini' }, fetchImpl: fake });
  assert.equal(ok.ok, true);
  assert.equal(ok.output, 'hello');
  assert.equal(seen[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(seen[0].body.max_tokens, 1000);
  assert.equal(ok.receipt.status, 'completed');
  assert.deepEqual(ok.receipt.cost.usage, { inputTokens: 12, outputTokens: 2 });
  assert.equal(ok.receipt.outputSha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(verifyReceipts(new Ledger(dir).all()), -1);
});

test('tampering with any receipt breaks the chain at that receipt', async () => {
  const dir = tmp();
  for (let i = 0; i < 3; i++) await infer(base, { load: loader(), ledgerDir: dir, env: {} });
  const lines = readFileSync(join(dir, 'receipts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(verifyReceipts(lines), -1);
  const forged = structuredClone(lines);
  forged[1].cost.quotedUsd = '0';
  assert.equal(verifyReceipts(forged), 1);
  const dropped = [lines[0], lines[2]];
  assert.equal(verifyReceipts(dropped), 1);
  writeFileSync(join(dir, 'x'), '');
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test('MCP infer tool: listed, not read-only, quotes through the snapshot loader', async () => {
  const dir = tmp();
  const f = async () => new Response(JSON.stringify(SNAP), { status: 200 });
  const h = makeServer({ fetchImpl: f, snapshotUrl: 'https://example.invalid/s.json', env: {}, ledgerDir: dir });
  const list = await h({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = list.result.tools.find((t) => t.name === 'infer');
  assert.equal(tool.annotations.readOnlyHint, false);
  const res = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'infer', arguments: base } });
  const body = JSON.parse(res.result.content[0].text);
  assert.equal(body.receipt.route.provider, 'openrouter:cheap/fp8');
  const bad = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'infer', arguments: { ...base, max_usd: '5' } } });
  assert.equal(bad.result.isError, true);
  assert.equal(JSON.parse(bad.result.content[0].text).field, 'max_usd');
});
