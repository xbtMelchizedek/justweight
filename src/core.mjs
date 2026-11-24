// justweight core: pure functions, no I/O, runs in Node and the browser.
// "A false balance is abomination to the LORD: but a just weight is his delight." (Proverbs 11:1)
//
// Every price here is a decimal string or number taken from a cited source. A missing price stays null;
// nothing is ever zero-filled, and nothing is converted to USD without a cited rate.

export const MODEL_RE = /^[A-Za-z0-9._\/:-]{1,120}$/;
export const MAX_TOKENS = 1_000_000_000;

export class InputError extends Error {
  constructor(field, detail) {
    super(`${field}: ${detail}`);
    this.name = 'InputError';
    this.field = field;
  }
}

/** Validate a quote request before any network call (dev-taste T1). */
export function validateJob(job) {
  if (job === null || typeof job !== 'object') throw new InputError('job', 'must be an object');
  const { model, inputTokens, outputTokens } = job;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    throw new InputError('model', 'must be 1-120 chars of letters, digits, . _ / : -');
  }
  for (const [k, v] of [['inputTokens', inputTokens], ['outputTokens', outputTokens]]) {
    if (!Number.isSafeInteger(v) || v < 0 || v > MAX_TOKENS) {
      throw new InputError(k, `must be an integer from 0 to ${MAX_TOKENS}`);
    }
  }
  if (inputTokens + outputTokens === 0) throw new InputError('tokens', 'input and output are both 0');
  return { model, inputTokens, outputTokens };
}

// Suffixes that name a serving variant (precision, enclave, tier), not a different model.
// They are kept in `variant` so a reader can see an FP8 or TEE quote is not the same artifact as BF16.
const VARIANT_SUFFIXES = ['-tee', '-fp8', '-bf16', '-nvfp4', '-turbo', '-fast'];

/** Map a provider model id to a comparison key plus its variant tags. */
export function canonicalModel(id) {
  let s = String(id).trim().toLowerCase();
  const variant = [];
  const colon = s.indexOf(':');
  if (colon >= 0) {
    variant.push(s.slice(colon + 1));
    s = s.slice(0, colon);
  }
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of VARIANT_SUFFIXES) {
      if (s.endsWith(suf)) {
        variant.push(suf.slice(1));
        s = s.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return { key: s, variant: variant.sort() };
}

/**
 * Exact decimal arithmetic on strings, so 0.0000005 * 2 never becomes 9.999e-7.
 * Values are scaled to 1e-24 integers (BigInt). Enough for FLOP's 18 decimals plus per-token prices.
 */
const SCALE = 24n;
const ONE = 10n ** SCALE;

export function toFixed(x) {
  if (x === null || x === undefined) return null;
  const s = typeof x === 'number' ? numberToPlain(x) : String(x).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [ip, fp = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = (fp + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  const v = BigInt(ip) * ONE + BigInt(frac || '0');
  return neg ? -v : v;
}

function numberToPlain(n) {
  if (!Number.isFinite(n)) return 'NaN';
  // String(n) is the shortest round-trip form; expand any exponent by moving the decimal point by hand.
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, ip, fp = '', e] = m;
  const digits = ip + fp;
  const point = ip.length + Number(e);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function fromFixed(v, places = 12) {
  if (v === null) return null;
  const neg = v < 0n;
  const a = neg ? -v : v;
  const ip = a / ONE;
  let fp = (a % ONE).toString().padStart(Number(SCALE), '0').slice(0, places).replace(/0+$/, '');
  return (neg ? '-' : '') + ip.toString() + (fp ? '.' + fp : '');
}

export const mulFixed = (a, b) => (a === null || b === null ? null : (a * b) / ONE);
export const addFixed = (a, b) => (a === null || b === null ? null : a + b);
export const cmpFixed = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Cost of one job at one offer. Prices are per 1M tokens in the offer's unit.
 * Returns null costs when a leg the job uses has no price.
 */
export function costOf(offer, job) {
  const M = toFixed(1_000_000);
  const legs = [
    [job.inputTokens, offer.inPer1M],
    [job.outputTokens, offer.outPer1M],
  ];
  let total = 0n;
  for (const [tokens, per1M] of legs) {
    if (tokens === 0) continue;
    const p = toFixed(per1M);
    if (p === null || p < 0n) return null; // negative = provider's "variable/unknown" sentinel
    total += (toFixed(tokens) * p) / M;
  }
  return total;
}

/**
 * Quote one job across offers.
 * - Groups by unit (USD, FLOP, TAO...). Units are never mixed without a cited conversion rate.
 * - `rates` maps unit -> { usd: decimal-string, source } and only converts when present.
 * - Sorted cheapest first inside each unit; USD (native or converted) is the cross-provider ranking.
 */
export function quote(offers, jobIn, rates = {}) {
  const job = validateJob(jobIn);
  const want = canonicalModel(job.model).key;
  const rows = [];
  for (const o of offers) {
    if (canonicalModel(o.model).key !== want) continue;
    const native = costOf(o, job);
    let usd = null;
    let usdBasis = null;
    if (native !== null) {
      if (o.unit === 'USD') {
        usd = native;
        usdBasis = 'native';
      } else if (rates[o.unit] && toFixed(rates[o.unit].usd) !== null) {
        usd = mulFixed(native, toFixed(rates[o.unit].usd));
        usdBasis = `${o.unit}/USD from ${rates[o.unit].source}`;
      }
    }
    rows.push({
      provider: o.provider,
      network: o.network ?? null,
      model: o.model,
      variant: canonicalModel(o.model).variant,
      unit: o.unit,
      cost: native === null ? null : fromFixed(native, 12),
      costUsd: usd === null ? null : fromFixed(usd, 9),
      usdBasis,
      inPer1M: o.inPer1M ?? null,
      outPer1M: o.outPer1M ?? null,
      effective: o.effective ?? null,
      latencyP50Ms: o.latencyP50Ms ?? null,
      privacy: o.privacy ?? null,
      notes: o.notes ?? [],
      source: o.source,
      _usd: usd,
    });
  }
  const ranked = rows
    .filter((r) => r._usd !== null)
    .sort((a, b) => cmpFixed(a._usd, b._usd) || a.provider.localeCompare(b.provider));
  const unpriced = rows.filter((r) => r._usd === null);
  for (const r of rows) delete r._usd;
  return {
    job,
    modelKey: want,
    cheapestUsd: ranked[0] ?? null,
    ranked,
    noUsdPrice: unpriced,
    matched: rows.length,
  };
}

/** Distinct comparison keys with the providers that list each, for discovery. */
export function listModels(offers) {
  const m = new Map();
  for (const o of offers) {
    const k = canonicalModel(o.model).key;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(o.provider);
  }
  return [...m.entries()]
    .map(([key, ps]) => ({ key, providers: [...ps].sort() }))
    .sort((a, b) => b.providers.length - a.providers.length || a.key.localeCompare(b.key));
}

/** Median of decimal strings, exact. Even count averages the middle two (rounded down at 1e-24). */
export function medianFixed(values) {
  const v = values.map(toFixed).filter((x) => x !== null).sort(cmpFixed);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2n;
}
