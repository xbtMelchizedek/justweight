// OpenRouter per-provider rows for the tier reference models.
// List price, quantization, data policy, zero-data-retention flag, p50 latency and throughput (last 30 min),
// and OpenRouter's published *effective* price and cache-hit rate per provider all come from the model page
// payload (the public API's /endpoints has list prices but no effective price and null latency today).
// The page is not a stable API: if it stops parsing, the source fails loudly and the rest still run.
import { toFixed, fromFixed, mulFixed } from '../core.mjs';

export const OR_PAGE = (id) => `https://openrouter.ai/${id}`;
const PER_1M = toFixed(1_000_000);

/** Bracket-match one JSON value starting at `start` (an opening { or [), respecting strings. */
export function sliceJson(text, start) {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, k + 1);
    }
  }
  return null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dec = (v, places) => {
  const f = toFixed(v);
  return f === null ? null : fromFixed(f, places);
};

/** Parse the page payload into per-provider offers for one model. */
export function parseOrPage(text, modelId) {
  const t = String(text);
  const summaries = new Map();
  const si = t.indexOf('"providerSummaries":');
  if (si >= 0) {
    const raw = sliceJson(t, t.indexOf('[', si));
    for (const s of raw ? JSON.parse(raw) : []) summaries.set(s.endpointId, s);
  }
  const endpoints = new Map();
  for (const m of t.matchAll(/\{"id":"[0-9a-f-]{36}","name":"/g)) {
    const raw = sliceJson(t, m.index);
    if (!raw) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!o.pricing_json || !o.provider_name) continue;
    const prev = endpoints.get(o.id);
    if (!prev || (o.stats && !prev.stats)) endpoints.set(o.id, o);
  }
  const out = [];
  for (const e of endpoints.values()) {
    if (e.is_disabled || e.is_hidden) continue;
    const pin = toFixed(e.pricing_json['openai:prompt_tokens']);
    const pout = toFixed(e.pricing_json['openai:completion_tokens']);
    if (pin === null || pout === null || pin < 0n || pout < 0n) continue;
    const s = summaries.get(e.id);
    const st = e.stats ?? {};
    const dp = e.provider_info?.dataPolicy ?? {};
    const retains = dp.retainsPrompts;
    const variant = e.variant && e.variant !== 'standard' ? e.variant : null;
    const quant = e.quantization && e.quantization !== 'unknown' ? e.quantization : null;
    const tagged = [quant, variant].filter(Boolean);
    const notes = [`OpenRouter list price via ${e.provider_name}`];
    if (s) notes.push(`effective ${dec(num(s.effectiveInputPrice), 6)} in / ${dec(num(s.effectiveOutputPrice), 6)} out per 1M at ${(num(s.cacheHitRate) * 100).toFixed(1)}% cache hits`);
    if (num(st.p50_latency) !== null) notes.push(`p50 latency ${Math.round(st.p50_latency)} ms, p50 ${st.p50_throughput ?? '?'} tok/s (last ${st.window_minutes ?? 30} min)`);
    if (e.is_zdr === true) notes.push('zero data retention (OpenRouter ZDR)');
    out.push({
      provider: `openrouter:${e.provider_slug ?? e.provider_name.toLowerCase().replace(/\s+/g, '-')}`,
      network: null,
      model: tagged.length ? `${modelId}:${tagged.join('-')}` : modelId,
      unit: 'USD',
      inPer1M: fromFixed(mulFixed(pin, PER_1M), 9),
      outPer1M: fromFixed(mulFixed(pout, PER_1M), 9),
      effective: s
        ? {
            inPer1M: dec(num(s.effectiveInputPrice), 9),
            outPer1M: dec(num(s.effectiveOutputPrice), 9),
            cacheHitRate: num(s.cacheHitRate),
            tokens: num(s.totalTokens),
          }
        : null,
      latencyP50Ms: num(st.p50_latency),
      throughputP50: num(st.p50_throughput),
      endpointId: e.id,
      privacy: {
        retention: e.is_zdr === true ? 'zero (OpenRouter ZDR)' : retains === false ? 'provider says prompts not retained' : retains === true ? 'provider retains prompts' : 'unknown',
        noRetention: e.is_zdr === true || retains === false,
        tee: false,
        e2ee: false,
        local: false,
      },
      notes,
      source: OR_PAGE(modelId),
    });
  }
  if (out.length === 0) throw new Error(`openrouter page ${modelId}: no endpoints parsed`);
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.endpointId.localeCompare(b.endpointId));
}
