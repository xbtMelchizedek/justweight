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

// ---- v0.2 sources ----
import { parseVenice, VENICE_ALIASES } from '../src/sources/venice.mjs';
import { parseOrPage, sliceJson } from '../src/sources/orproviders.mjs';
import { localOffers } from '../src/sources/local.mjs';
import { iuTable, iuOf, TIERS } from '../src/tiers.mjs';
import { TESTNET_GENESIS } from '../src/sources/flop.mjs';

const orPage = (slug) => fx(`or_page_${slug.replace('/', '_')}.rsc.txt`);

test('venice: USD and DIEM prices, aliases to OpenRouter ids, privacy flags, x402 note', () => {
  const offers = parseVenice(j('venice_models.json'));
  const q = offers.find((o) => o.veniceId === 'qwen-3-8-27b');
  assert.equal(q.model, 'qwen/qwen3.8-27b');
  assert.equal(q.inPer1M, '0.45');
  assert.equal(q.outPer1M, '3.2');
  assert.equal(q.privacy.noRetention, true);
  assert.ok(q.notes.some((n) => /x402/.test(n)));
  const e2ee = offers.find((o) => o.veniceId === 'e2ee-qwen3-8-27b');
  assert.equal(e2ee.privacy.e2ee, true);
  assert.equal(e2ee.privacy.tee, true);
  const anon = offers.find((o) => o.veniceId === 'gemini-4-carbon');
  assert.equal(anon.model, 'venice/gemini-4-carbon', 'unaliased ids never match another venue');
  assert.equal(anon.privacy.noRetention, false);
  assert.throws(() => parseVenice({ data: [] }));
  assert.throws(() => parseVenice({}));
  for (const v of Object.values(VENICE_ALIASES)) assert.match(v, /^[a-z0-9.-]+\/[a-z0-9.:-]+$/);
});

test('venice joins the same-model quote with Pearl and Chutes', () => {
  const offers = [...parseVenice(j('venice_models.json')), ...parsePearl(fx('pearl_pricing.html')), ...parseChutes(j('chutes_models.json'))];
  const q = quote(offers, { model: 'qwen/qwen3.8-27b', inputTokens: 100000, outputTokens: 20000 });
  const ps = q.ranked.map((r) => r.provider);
  for (const p of ['venice', 'pearl-labs', 'chutes-bittensor']) assert.ok(ps.includes(p), p);
  const plain = q.ranked.find((r) => r.provider === 'venice' && r.variant.length === 0);
  assert.equal(plain.costUsd, '0.109'); // 0.45 x 0.1 + 3.2 x 0.02
  assert.equal(q.ranked.at(-1).variant[0], 'e2ee'); // 0.047 + 0.0706: encryption costs a little more
});

test('openrouter page: per-provider list, effective, cache hits, latency, ZDR; Pearl is a provider', () => {
  const rows = parseOrPage(orPage('qwen/qwen3.8-27b'), 'qwen/qwen3.8-27b');
  assert.equal(rows.length, 21);
  const pearl = rows.find((r) => r.provider === 'openrouter:pearl-research/fp8');
  assert.equal(pearl.inPer1M, '0.1');
  assert.equal(pearl.outPer1M, '2');
  assert.equal(pearl.effective.inPer1M, '0.044821319');
  assert.equal(pearl.effective.outPer1M, '2');
  assert.ok(Math.abs(pearl.effective.cacheHitRate - 0.6893) < 1e-4);
  assert.equal(pearl.latencyP50Ms, 1286);
  assert.equal(pearl.privacy.noRetention, true);
  assert.deepEqual(rows.find((r) => r.provider === 'openrouter:darkbloom/fp4').privacy.noRetention, false);
  // Every row keeps the precision tag, so fp4 and fp8 are never silently compared as one artifact.
  assert.ok(rows.filter((r) => r.provider !== 'openrouter:modal' && r.provider !== 'openrouter:cloudflare' && r.provider !== 'openrouter:streamlake').every((r) => /:/.test(r.model)));
  const ink = parseOrPage(orPage('thinkingmachines/inkling-2-mini'), 'thinkingmachines/inkling-2-mini');
  assert.equal(ink.length, 5);
  assert.equal(ink.find((r) => r.provider === 'openrouter:primeintellect/flex').inPer1M, '0.0375');
  assert.throws(() => parseOrPage('<html>error</html>', 'qwen/qwen3.8-27b'), /no endpoints/);
});

test('sliceJson respects strings and nesting; returns null when unbalanced', () => {
  assert.equal(sliceJson('x{"a":"}{]","b":[1,{"c":2}]}y', 1), '{"a":"}{]","b":[1,{"c":2}]}');
  assert.equal(sliceJson('{"a":"\\"}"}', 0), '{"a":"\\"}"}');
  assert.equal(sliceJson('{"a":1', 0), null);
  assert.equal(sliceJson('abc', 0), null);
});

test('local venue: unit LOCAL so it never wins a USD ranking', () => {
  const [l] = localOffers();
  assert.equal(l.unit, 'LOCAL');
  const q = quote([...localOffers(), ...parseVenice(j('venice_models.json'))], { model: 'thinkingmachines/inkling-2-mini', inputTokens: 1000, outputTokens: 1000 });
  assert.equal(q.cheapestUsd.provider, 'venice');
  assert.equal(q.noUsdPrice[0].provider, 'local');
  assert.equal(q.noUsdPrice[0].cost, '0');
});

test('IU table: 750k in + 250k out, cheapest per venue, FLOP waits for receipts', () => {
  const offers = [
    ...parseVenice(j('venice_models.json')),
    ...parsePearl(fx('pearl_pricing.html')),
    ...parseChutes(j('chutes_models.json')),
    ...localOffers(),
    ...TIERS.flatMap((t) => parseOrPage(orPage(t.model), t.model)),
  ];
  const t = iuTable(offers, { testnet: parseTestnet(j('flop_testnet_models.json')) });
  const mid = t.rows.find((r) => r.tier === 'mid');
  // Pearl direct 0.1/2.00 -> 0.075 + 0.5 = 0.575 per IU; OpenRouter's Pearl row ties at list, effective is lower.
  assert.equal(mid.cells.pearl.list, '0.575');
  assert.equal(mid.cells.pearl.effectiveVia, 'openrouter:pearl-research/fp8');
  assert.equal(mid.cells.venice.list, '1.1375'); // 0.45*0.75 + 3.2*0.25
  assert.equal(mid.cells.flop.list, null);
  assert.match(mid.cells.flop.reason, /0 models/);
  const mini = t.rows.find((r) => r.tier === 'mini');
  assert.equal(mini.cells.local.list, '0');
  assert.equal(mini.cells.local.unit, 'LOCAL');
  assert.equal(mini.cells.openrouter.list, '0.065625'); // primeintellect flex 0.0375*0.75 + 0.15*0.25
  assert.equal(mini.cells.pearl.reason, 'not listed');
  assert.equal(iuOf({ inPer1M: '1', outPer1M: '1' }), '1');
  assert.equal(iuOf({ inPer1M: null, outPer1M: '1' }), null);
});

test('IU table: FLOP column fills from receipt-priced rows, never from list price', () => {
  const realized = { provider: 'flop-realized', network: 'testnet', model: 'qwen/qwen3.8-27b', unit: 'FLOP', inPer1M: '4', outPer1M: '8', source: 'x' };
  const listOnly = { ...realized, provider: 'flop-gateway', inPer1M: '1', outPer1M: '1' };
  const t = iuTable([realized, listOnly]);
  const c = t.rows.find((r) => r.tier === 'mid').cells.flop;
  assert.equal(c.list, '5'); // 4*0.75 + 8*0.25, in FLOP, not converted
  assert.equal(c.unit, 'FLOP');
});

test('testnet price index: genesis pinned per network; 0-trade hours give no price', () => {
  const body = j('flop_testnet_price_index.json');
  assert.equal(body.genesisHash, TESTNET_GENESIS);
  assert.equal(parsePriceIndex(body, 'testnet'), null);
  assert.throws(() => parsePriceIndex(body, 'devnet'), /not the pinned devnet genesis/);
  assert.throws(() => parsePriceIndex(j('flop_price_index.json'), 'testnet'), /not the pinned testnet genesis/);
  assert.throws(() => parsePriceIndex({ ...j('flop_price_index.json'), genesisHash: undefined }), /genesis/);
});

import { parseDeepInfra } from '../src/sources/deepinfra.mjs';

test('deepinfra converts cents per token and skips deprecated or unpriced models', () => {
  const models = j('deepinfra_models.json');
  const offers = parseDeepInfra(models);
  assert.deepEqual(offers.map(o => [o.model, o.inPer1M, o.outPer1M]), [
    ['Qwen/Qwen3.8-27B', '0.15', '1.875'],
  ]);
  const model = models.find(m => m.model_name === 'Qwen/Qwen3.8-27B');
  const undiscounted = { ...model, pricing: { ...model.pricing, discount: null } };
  assert.equal(parseDeepInfra([undiscounted])[0].outPer1M, '2.5');
  const withInput = value => ({ ...model, pricing: { ...model.pricing, cents_per_input_token: value } });
  assert.throws(() => parseDeepInfra({}), /model list/);
  assert.throws(() => parseDeepInfra([withInput(null)]), /no priced text models/);
  assert.equal(parseDeepInfra([withInput(0)])[0].inPer1M, '0');
});
