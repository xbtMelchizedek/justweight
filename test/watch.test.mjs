import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchAll } from '../src/fetchAll.mjs';
import { iuTable } from '../src/tiers.mjs';
import { parseTestnet, parseGateway, parsePriceIndex, testnetGatewayModelsUrl, flopWatch, realizedOffers } from '../src/sources/flop.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const j = (f) => JSON.parse(fx(f));

// Same host/path router as cli_mcp.test.mjs, with the testnet entries swappable.
function fakeFetch(testnet) {
  const routes = [
    ['api.flop.network', '', 'flop_gateway_models.json'],
    ['explorer.devnet.flop.network', '', 'flop_price_index.json'],
    ['testnet.flopscan.io', '/api/price-index', testnet.index],
    ['testnet.flopscan.io', '/api/models', testnet.models],
    ['gateway.testnet.flop.network', '/v1/models', testnet.gateway],
    ['openrouter.ai', '/api/v1/models', 'openrouter_models.json'],
    ['openrouter.ai', '/qwen/qwen3.8-27b', 'or_page_qwen_qwen3.8-27b.rsc.txt'],
    ['openrouter.ai', '/deepseek/deepseek-v4.1-flash-1017', 'or_page_deepseek_deepseek-v4.1-flash-1017.rsc.txt'],
    ['openrouter.ai', '/thinkingmachines/inkling-2-mini', 'or_page_thinkingmachines_inkling-2-mini.rsc.txt'],
    ['llm.chutes.ai', '', 'chutes_models.json'],
    ['pearlresearch.ai', '', 'pearl_pricing.html'],
    ['api.venice.ai', '', 'venice_models.json'],
    ['api.coingecko.com', '', 'coingecko.json'],
  ];
  const f = async (url) => {
    f.calls.push(url);
    const u = new URL(url);
    const r = routes.find(([h, p]) => h === u.host && u.pathname.startsWith(p));
    if (!r || !r[2]) return new Response('missing', { status: 404 });
    return new Response(fx(r[2]), { status: 200 });
  };
  f.calls = [];
  return f;
}

test('watcher: gateway URL only once models are listed, and only on a Flop-hosted https origin', () => {
  const t = parseTestnet(j('synthetic_testnet_models.json'));
  assert.equal(testnetGatewayModelsUrl(t), 'https://gateway.testnet.flop.network/v1/models');
  assert.equal(testnetGatewayModelsUrl(parseTestnet(j('flop_testnet_models.json'))), null, '0 models today');
  for (const gateway of ['http://gateway.testnet.flop.network', 'https://flop.network.evil.example', 'https://evilflop.network', 'https://x.example/flop.network', null, 7]) {
    assert.equal(testnetGatewayModelsUrl({ ...t, gateway }), null, String(gateway));
  }
  assert.equal(testnetGatewayModelsUrl({ ...t, gateway: 'https://testnet.flopscan.io/gw/' }), 'https://testnet.flopscan.io/gw/v1/models');
});

test('watcher: one readable stage for every step between today and a filled column', () => {
  const t0 = parseTestnet(j('flop_testnet_models.json'));
  const t1 = parseTestnet(j('synthetic_testnet_models.json'));
  const url = testnetGatewayModelsUrl(t1);
  const gw = parseGateway(j('synthetic_testnet_gateway_models.json'), { network: 'testnet', sourceUrl: url });
  const idx = parsePriceIndex(j('synthetic_testnet_price_index.json'), 'testnet');
  const stage = (o) => flopWatch(o).stage;
  assert.equal(stage({ testnet: null }), 'explorer-down');
  assert.equal(stage({ testnet: t0 }), 'no-models');
  assert.equal(stage({ testnet: { ...t1, gateway: null }, testnetGatewayUrl: null }), 'no-gateway');
  assert.equal(stage({ testnet: t1, testnetGatewayUrl: url, testnetGateway: null }), 'gateway-unreadable');
  assert.equal(stage({ testnet: t1, testnetGatewayUrl: url, testnetGateway: gw, testnetIndex: null }), 'no-receipt-hour');
  assert.equal(stage({ testnet: t1, testnetGatewayUrl: url, testnetGateway: gw, testnetIndex: { ...idx, floorsPassed: false } }), 'below-floors');
  const realized = realizedOffers(gw, idx);
  assert.equal(realized.length, 1);
  assert.equal(stage({ testnet: t1, testnetGatewayUrl: url, testnetGateway: gw, testnetIndex: idx, realized }), 'filled');
  // Devnet receipts never count as the testnet column.
  assert.equal(stage({ testnet: t0, realized: realized.map((o) => ({ ...o, network: 'devnet' })) }), 'no-models');
});

test('fetchAll today: testnet has 0 models, the gateway is not even asked, the column says why', async () => {
  const f = fakeFetch({ models: 'flop_testnet_models.json', index: 'flop_testnet_price_index.json', gateway: null });
  const snap = await fetchAll({ fetchImpl: f });
  assert.equal(snap.flop.watch.stage, 'no-models');
  assert.ok(!f.calls.some((u) => u.includes('gateway.testnet')));
  const mid = iuTable(snap.offers, { testnet: snap.flop.testnet, watch: snap.flop.watch }).rows.find((r) => r.tier === 'mid');
  assert.equal(mid.cells.flop.list, null);
  assert.match(mid.cells.flop.reason, /0 models/);
});

test('fetchAll once testnet lists a priced model and a receipt hour clears floors: the column fills itself', async () => {
  const f = fakeFetch({ models: 'synthetic_testnet_models.json', index: 'synthetic_testnet_price_index.json', gateway: 'synthetic_testnet_gateway_models.json' });
  const snap = await fetchAll({ fetchImpl: f });
  assert.equal(snap.flop.watch.stage, 'filled');
  assert.ok(snap.sources.find((s) => s.id === 'flop-testnet-gateway')?.ok);
  const mid = iuTable(snap.offers, { testnet: snap.flop.testnet, watch: snap.flop.watch }).rows.find((r) => r.tier === 'mid');
  // 0.000002 FLOP/G_n x 2 G_n per token x 1M = 4 FLOP per 1M, in and out -> 4 FLOP per IU. Never converted to USD.
  assert.equal(mid.cells.flop.list, '4');
  assert.equal(mid.cells.flop.unit, 'FLOP');
  assert.equal(mid.cells.flop.via, 'flop-realized');

  // Gateway down: the stage says so and the rest of the snapshot is unaffected.
  const down = fakeFetch({ models: 'synthetic_testnet_models.json', index: 'synthetic_testnet_price_index.json', gateway: null });
  const s2 = await fetchAll({ fetchImpl: down });
  assert.equal(s2.flop.watch.stage, 'gateway-unreadable');
  assert.ok(s2.offers.length > 100);
});
