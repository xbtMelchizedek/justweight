// Fetch every source with its own try/catch: one dead source never hides the others (dev-taste S).
import * as flop from './sources/flop.mjs';
import * as usd from './sources/usd.mjs';

const UA = 'justweight/0.1 (+https://github.com/xbtMelchizedek/justweight)';

async function get(fetchImpl, url, { kind = 'json', timeoutMs = 30_000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: kind === 'json' ? 'application/json' : 'text/html' },
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
  const [gw, index, testnet, or, ch, pearl, rates] = await Promise.all([
    run('flop-gateway', flop.GATEWAY_URL, {}, flop.parseGateway),
    run('flop-price-index', flop.PRICE_INDEX_URL, { timeoutMs: 120_000 }, flop.parsePriceIndex),
    run('flop-testnet', flop.TESTNET_MODELS_URL, {}, flop.parseTestnet),
    run('openrouter', usd.OPENROUTER_URL, {}, usd.parseOpenRouter),
    run('chutes-bittensor', usd.CHUTES_URL, {}, usd.parseChutes),
    run('pearl-labs', usd.PEARL_URL, { kind: 'text' }, usd.parsePearl),
    run('coingecko', usd.COINGECKO_URL, {}, usd.parseRates),
  ]);
  const realized = flop.realizedOffers(gw ?? [], index);
  const offers = [...(gw ?? []), ...realized, ...(or ?? []), ...(ch ?? []), ...(pearl ?? [])];
  sources.sort((a, b) => a.id.localeCompare(b.id));
  return {
    generatedAt: now().toISOString(),
    sources,
    offers,
    rates: rates ?? {},
    flop: { priceIndex: index, testnet },
  };
}

/** Only rates with a cited USD price may convert. FLOP has none until a real market exists. */
export function usableRates(rates) {
  const out = {};
  for (const [unit, r] of Object.entries(rates ?? {})) if (r && r.usd !== null) out[unit] = r;
  return out;
}
