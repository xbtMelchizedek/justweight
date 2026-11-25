// Fetch every source with its own try/catch: one dead source never hides the others (dev-taste S).
import { readFileSync } from 'node:fs';
import * as flop from './sources/flop.mjs';
import * as usd from './sources/usd.mjs';
import { DEEPINFRA_URL, parseDeepInfra } from './sources/deepinfra.mjs';
import { parseVenice, VENICE_URL } from './sources/venice.mjs';
import { parseOrPage, OR_PAGE } from './sources/orproviders.mjs';
import { localOffers } from './sources/local.mjs';
import { TIERS } from './tiers.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const UA = `justweight/${VERSION} (+https://github.com/xbtMelchizedek/justweight)`;

async function get(fetchImpl, url, { kind = 'json', timeoutMs = 30_000 } = {}) {
  const res = await fetchImpl(url, {
    headers: {
      'user-agent': UA,
      accept: kind === 'json' ? 'application/json' : 'text/html',
      ...(kind === 'rsc' ? { rsc: '1' } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return kind === 'json' ? res.json() : res.text();
}

export async function fetchAll({ fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const sources = [];
  const run = async (id, url, opts, parse) => {
    const fetchedAt = now().toISOString();
    try {
      const value = parse(await get(fetchImpl, url, opts));
      sources.push({ id, url, ok: true, fetchedAt, count: Array.isArray(value) ? value.length : null });
      return value;
    } catch (e) {
      sources.push({ id, url, ok: false, fetchedAt, error: String(e?.message ?? e).slice(0, 300) });
      return null;
    }
  };
  const [gw, index, testnet, tIndex, or, ch, pearl, venice, deepinfra, rates, ...orp] = await Promise.all([
    run('flop-gateway', flop.GATEWAY_URL, {}, flop.parseGateway),
    run('flop-price-index', flop.PRICE_INDEX_URL, { timeoutMs: 120_000 }, (b) => flop.parsePriceIndex(b, 'devnet')),
    run('flop-testnet', flop.TESTNET_MODELS_URL, {}, flop.parseTestnet),
    run('flop-testnet-price-index', flop.TESTNET_PRICE_INDEX_URL, {}, (b) => flop.parsePriceIndex(b, 'testnet')),
    run('openrouter', usd.OPENROUTER_URL, {}, usd.parseOpenRouter),
    run('chutes-bittensor', usd.CHUTES_URL, {}, usd.parseChutes),
    run('pearl-labs', usd.PEARL_URL, { kind: 'text' }, usd.parsePearl),
    run('venice', VENICE_URL, {}, parseVenice),
    run('deepinfra', DEEPINFRA_URL, {}, parseDeepInfra),
    run('coingecko', usd.COINGECKO_URL, {}, usd.parseRates),
    ...TIERS.map((t) => run(`openrouter-providers:${t.model}`, OR_PAGE(t.model), { kind: 'rsc' }, (b) => parseOrPage(b, t.model))),
  ]);
  // Watcher: once the testnet explorer lists models and advertises a Flop-hosted gateway, read its catalog too.
  const tgwUrl = flop.testnetGatewayModelsUrl(testnet);
  const tgw = tgwUrl ? await run('flop-testnet-gateway', tgwUrl, {}, (b) => flop.parseGateway(b, { network: 'testnet', sourceUrl: tgwUrl })) : null;
  // Receipt-priced FLOP rows: devnet now; testnet the moment its gateway lists models and an hour clears floors.
  const realized = [...flop.realizedOffers(gw ?? [], index), ...flop.realizedOffers(tgw ?? [], tIndex)];
  const watch = flop.flopWatch({ testnet, testnetGateway: tgw, testnetGatewayUrl: tgwUrl, testnetIndex: tIndex, realized });
  const offers = [
    ...(gw ?? []),
    ...(tgw ?? []),
    ...realized,
    ...(or ?? []),
    ...orp.flatMap((x) => x ?? []),
    ...(ch ?? []),
    ...(pearl ?? []),
    ...(venice ?? []),
    ...(deepinfra ?? []),
    ...localOffers(),
  ];
  sources.sort((a, b) => a.id.localeCompare(b.id));
  return {
    generatedAt: now().toISOString(),
    sources,
    offers,
    rates: rates ?? {},
    flop: { priceIndex: index, testnetPriceIndex: tIndex, testnet, watch },
  };
}

/** Only rates with a cited USD price may convert. FLOP has none until a real market exists. */
export function usableRates(rates) {
  const out = {};
  for (const [unit, r] of Object.entries(rates ?? {})) if (r && r.usd !== null) out[unit] = r;
  return out;
}
