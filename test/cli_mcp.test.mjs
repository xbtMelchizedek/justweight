import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main } from '../src/cli.mjs';
import { makeServer, TOOLS } from '../src/mcp.mjs';
import { fetchAll } from '../src/fetchAll.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const routes = {
  'api.flop.network': ['flop_gateway_models.json'],
  'explorer.devnet.flop.network': ['flop_price_index.json'],
  'testnet.flopscan.io': ['flop_testnet_models.json'],
  'openrouter.ai': ['openrouter_models.json'],
  'llm.chutes.ai': ['chutes_models.json'],
  'pearlresearch.ai': ['pearl_pricing.html'],
  'api.coingecko.com': ['coingecko.json'],
};
function fakeFetch({ down = [] } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const host = new URL(url).host;
    if (down.includes(host)) return new Response('nope', { status: 503 });
    const r = routes[host];
    if (!r) return new Response('missing', { status: 404 });
    return new Response(fx(r[0]), { status: 200 });
  };
  f.calls = calls;
  return f;
}

test('bad CLI input exits 2 and never touches the network (T1)', async () => {
  for (const argv of [
    ['quote', '--model', 'a b', '--in', '1', '--out', '1'],
    ['quote', '--model', 'm', '--in', '-1'],
    ['quote', '--model', 'm'],
    ['quote', '--model'],
    ['bogus'],
  ]) {
    const f = fakeFetch();
    const out = [];
    const code = await main(argv, { fetchImpl: f, out: (s) => out.push(s) });
    assert.equal(code, 2, argv.join(' '));
    assert.equal(f.calls.length, 0, argv.join(' '));
  }
});

test('one dead source does not hide the others', async () => {
  const snap = await fetchAll({ fetchImpl: fakeFetch({ down: ['pearlresearch.ai'] }) });
  const pearl = snap.sources.find((s) => s.id === 'pearl-labs');
  assert.equal(pearl.ok, false);
  assert.match(pearl.error, /503/);
  assert.ok(snap.offers.some((o) => o.provider === 'chutes-bittensor'));
  assert.ok(snap.offers.some((o) => o.provider === 'flop-realized'));
  assert.equal(snap.flop.testnet.models, 0);
});

test('CLI quote over fake live sources', async () => {
  const out = [];
  const code = await main(['quote', '--model', 'qwen/qwen3.8-27b', '--in', '100000', '--out', '20000'], {
    fetchImpl: fakeFetch(),
    out: (s) => out.push(s),
  });
  assert.equal(code, 0);
  const r = JSON.parse(out[0]);
  assert.equal(r.ok, true);
  assert.ok(r.cheapestUsd);
  assert.deepEqual(r.failedSources, []);
});

test('MCP: initialize, tools/list, quote, bad input rejected before fetch', async () => {
  const f = fakeFetch();
  const snap = await fetchAll({ fetchImpl: fakeFetch() });
  const snapFetch = async (url) => {
    f.calls.push(url);
    return new Response(JSON.stringify(snap), { status: 200 });
  };
  const h = makeServer({ fetchImpl: snapFetch, snapshotUrl: 'https://example.invalid/s.json' });
  const init = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'justweight');
  assert.equal((await h({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  const list = await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint));
  const before = f.calls.length;
  const bad = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'justweight_quote', arguments: { model: 'm', inputTokens: 0, outputTokens: 0 } } });
  assert.equal(bad.result.isError, true);
  assert.equal(f.calls.length, before);
  const ok = await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'justweight_quote', arguments: { model: 'qwen3-14b', inputTokens: 1000, outputTokens: 1000 } } });
  const body = JSON.parse(ok.result.content[0].text);
  assert.ok(body.matched >= 2);
  assert.ok(body.noUsdPrice.some((r) => r.provider === 'flop-gateway'));
  const unknown = await h({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
  assert.equal(unknown.error.code, -32602);
  const nf = await h({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(nf.error.code, -32601);
});
