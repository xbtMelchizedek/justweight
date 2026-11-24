import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGateway, parsePriceIndex, realizedOffers, parseTestnet, DEVNET_GENESIS } from '../src/sources/flop.mjs';
import { parseOpenRouter, parseChutes, parsePearl, parseRates } from '../src/sources/usd.mjs';
import { quote } from '../src/core.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const j = (f) => JSON.parse(fx(f));

test('flop gateway: price = flop_per_gn x gn_per_token, devnet flagged, nominal USD never used', () => {
  const offers = parseGateway(j('flop_gateway_models.json'));
  const q14 = offers.find((o) => o.model === 'qwen/qwen3-14b');
  assert.equal(q14.unit, 'FLOP');
  assert.equal(q14.network, 'devnet');
  assert.equal(q14.inPer1M, '15'); // 0.0000005 FLOP/G_n x 30 G_n/token x 1e6
  assert.equal(q14.outPer1M, '15');
  assert.ok(q14.notes.some((n) => /nominal/.test(n)));
  assert.ok(!q14.notes.some((n) => /disagrees/.test(n)), 'pricing field agrees with signed sources in this fixture');
  assert.equal(offers.find((o) => o.model === 'qwen/qwen2.5-0.5b-instruct').inPer1M, '1');
});

test('flop gateway: disagreement between pricing field and signed sources is surfaced', () => {
  const body = j('flop_gateway_models.json');
  body.data[0].pricing.prompt = '0.5';
  const o = parseGateway(body)[0];
  assert.ok(o.notes.some((n) => /disagrees/.test(n)));
});

test('flop gateway: model without signed prices yields no offer; junk body throws', () => {
  const body = j('flop_gateway_models.json');
  body.data[0]['x-flop'].price_sources = [];
  assert.equal(parseGateway(body).length, j('flop_gateway_models.json').data.length - 1);
  assert.throws(() => parseGateway({ error: 'x' }));
});

test('flop price index: last complete observed hour, genesis pinned, realized offers need floors', () => {
  const body = j('flop_price_index.json');
  const idx = parsePriceIndex(body);
  assert.equal(idx.network, 'devnet');
  assert.equal(idx.settlementGrade, false);
  assert.ok(Number(idx.flopPerGn) > 0);
  const real = realizedOffers(parseGateway(j('flop_gateway_models.json')), idx);
  assert.ok(real.length > 0);
  assert.equal(real[0].provider, 'flop-realized');
  assert.throws(() => parsePriceIndex({ ...body, genesisHash: '0xdead' }), /pinned devnet genesis/);
  assert.deepEqual(realizedOffers([], { ...idx, floorsPassed: false }), []);
  assert.equal(DEVNET_GENESIS.length, 66);
});

test('flop testnet: empty registry is reported as a fact; error body throws', () => {
  const t = parseTestnet(j('flop_testnet_models.json'));
  assert.equal(t.models, 0);
  assert.equal(t.gateway, null);
  assert.equal(t.genesisHash, '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800');
  assert.throws(() => parseTestnet(j('flop_testnet_error.json')));
});

test('openrouter: per-token USD scaled to per 1M; negative sentinel dropped', () => {
  const body = j('openrouter_models.json');
  const o = parseOpenRouter(body);
  const q = o.find((x) => x.model === 'qwen/qwen3-14b');
  assert.equal(q.inPer1M, '0.12');
  assert.equal(q.outPer1M, '0.24');
  body.data.push({ id: 'neg/x', pricing: { prompt: '-1', completion: '-1' } });
  assert.equal(parseOpenRouter(body).some((x) => x.model === 'neg/x'), false);
});

test('chutes: USD per 1M with TAO in notes', () => {
  const o = parseChutes(j('chutes_models.json'));
  const q = o.find((x) => x.model === 'Qwen/Qwen3.8-27B-TEE');
  assert.equal(q.inPer1M, '0.039');
  assert.equal(q.outPer1M, '1.25');
  assert.ok(q.notes.some((n) => /TAO per 1M/.test(n)));
});

test('pearl: parses the public pricing table, dedupes the mobile copy, empty page throws', () => {
  const o = parsePearl(fx('pearl_pricing.html'));
  const q = o.find((x) => x.model === 'Qwen/Qwen3.8-27B');
  assert.equal(q.inPer1M, '0.1');
  assert.equal(q.outPer1M, '2');
  assert.equal(new Set(o.map((x) => x.model)).size, o.length);
  assert.throws(() => parsePearl('<html>maintenance</html>'), /not found/);
});

test('rates: FLOP has no market price and stays unknown', () => {
  const r = parseRates(j('coingecko.json'));
  assert.equal(r.FLOP.usd, null);
  assert.equal(r.TAO.usd, '183.42');
});

test('end to end on fixtures: qwen3.8-27b across Chutes, Pearl and OpenRouter', () => {
  const offers = [
    ...parseChutes(j('chutes_models.json')),
    ...parsePearl(fx('pearl_pricing.html')),
    ...parseOpenRouter(j('openrouter_models.json')),
  ];
  const q = quote(offers, { model: 'qwen/qwen3.8-27b', inputTokens: 100_000, outputTokens: 20_000 });
  const providers = new Set(q.ranked.map((r) => r.provider));
  for (const p of ['chutes-bittensor', 'pearl-labs', 'openrouter']) assert.ok(providers.has(p), p);
  // Chutes: 0.1 x 0.039 + 0.02 x 1.25 = 0.0289 ; Pearl: 0.01 + 0.04 = 0.05
  assert.equal(q.ranked.find((r) => r.provider === 'chutes-bittensor').costUsd, '0.0289');
  assert.equal(q.ranked.find((r) => r.provider === 'pearl-labs').costUsd, '0.05');
  for (let i = 1; i < q.ranked.length; i++) assert.ok(Number(q.ranked[i - 1].costUsd) <= Number(q.ranked[i].costUsd));
});
