// USD-priced inference sources. Each parser is pure and cites its URL.
import { toFixed, fromFixed, mulFixed } from '../core.mjs';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
export const CHUTES_URL = 'https://llm.chutes.ai/v1/models';
export const PEARL_URL = 'https://pearlresearch.ai/pricing';
export const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=pearl-2,bittensor,flop-labs&vs_currencies=usd&include_last_updated_at=true';

const PER_1M = toFixed(1_000_000);

/** OpenRouter: USD per token strings. Negative is OpenRouter's "variable" sentinel and stays unknown. */
export function parseOpenRouter(body) {
  if (!body || !Array.isArray(body.data)) throw new Error('openrouter: no data array');
  const out = [];
  for (const m of body.data) {
    const pi = toFixed(m.pricing?.prompt);
    const po = toFixed(m.pricing?.completion);
    if (pi === null || po === null || pi < 0n || po < 0n) continue;
    out.push({
      provider: 'openrouter',
      network: null,
      model: m.id,
      unit: 'USD',
      inPer1M: fromFixed(mulFixed(pi, PER_1M), 9),
      outPer1M: fromFixed(mulFixed(po, PER_1M), 9),
      notes: pi === 0n && po === 0n ? ['free tier, rate limited'] : ['OpenRouter list price; routes to an upstream provider'],
      source: OPENROUTER_URL,
    });
  }
  return out;
}

/** Chutes (Bittensor subnet 64): per-1M prices in both USD and TAO. */
export function parseChutes(body) {
  if (!body || !Array.isArray(body.data)) throw new Error('chutes: no data array');
  const out = [];
  for (const m of body.data) {
    const usdIn = m.price?.input?.usd ?? m.pricing?.prompt;
    const usdOut = m.price?.output?.usd ?? m.pricing?.completion;
    if (toFixed(usdIn) === null || toFixed(usdOut) === null) continue;
    const notes = ['Bittensor SN64 (Chutes) list price'];
    if (m.price?.input?.tao !== undefined) notes.push(`TAO per 1M: in ${m.price.input.tao}, out ${m.price.output.tao}`);
    if (m.confidential_compute) notes.push('confidential compute (TEE)');
    out.push({
      provider: 'chutes-bittensor',
      network: null,
      model: m.id,
      unit: 'USD',
      inPer1M: String(usdIn),
      outPer1M: String(usdOut),
      // Chutes publishes the TEE flag; it publishes no retention policy in this API, so that stays unknown.
      privacy: { retention: 'unknown', noRetention: false, tee: m.confidential_compute === true, e2ee: false, local: false },
      notes,
      source: CHUTES_URL,
    });
  }
  return out;
}

/**
 * Pearl Research Labs serverless pricing page (USD per 1M). The API's /models needs a key, so the public
 * page is the only unauthenticated source. Parsing a page is fragile: zero rows is an error, never "free".
 */
export function parsePearl(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const re = /([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)\s+\$\s*([\d.]+)/g;
  const seen = new Set();
  const out = [];
  for (const [, id, inp, cached, outp] of text.matchAll(re)) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      provider: 'pearl-labs',
      network: null,
      model: id,
      unit: 'USD',
      inPer1M: inp,
      outPer1M: outp,
      notes: [`cached input ${cached}/1M`, 'page says special launch pricing; paid in USD, not PRL'],
      source: PEARL_URL,
    });
  }
  if (out.length === 0) throw new Error('pearl: pricing table not found on page');
  return out;
}

/** CoinGecko spot rates. A coin with no price (FLOP has no market) is reported as unknown. */
export function parseRates(body) {
  const pick = (id, unit) => {
    const v = body?.[id]?.usd;
    return v === undefined
      ? { unit, usd: null, source: COINGECKO_URL, note: 'no market price listed' }
      : { unit, usd: String(v), source: COINGECKO_URL, updatedAt: body[id].last_updated_at ?? null };
  };
  return { TAO: pick('bittensor', 'TAO'), PRL: pick('pearl-2', 'PRL'), FLOP: pick('flop-labs', 'FLOP') };
}
