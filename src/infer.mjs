// infer: quote, route and (only for free local models) run one inference call, with hard spend caps
// and a hash-chained receipt for every call. Default mode is "quote": it spends nothing and calls nothing
// but the price snapshot. justweight holds no API key, so paid venues are only ever quoted, never called.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalModel, costOf, fromFixed, toFixed, cmpFixed, InputError, MODEL_RE } from './core.mjs';
import { TIERS } from './tiers.mjs';

// Hard ceilings. Callers and env vars can lower these, never raise them.
export const HARD_CALL_CAP_USD = '0.50';
export const HARD_DAILY_CAP_USD = '5';
export const DEFAULT_DAILY_CAP_USD = '1';
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_BUDGET_TOKENS = 32_768;
export const PRIVACY = ['any', 'no-retention', 'tee', 'local'];
export const MODES = ['quote', 'live'];
const RECEIPT_V = 'justweight-receipt/1';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Stable JSON: sorted keys, so a receipt hashes the same everywhere. */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

function decimal(field, v, max) {
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d+(\.\d{1,9})?$/.test(s)) throw new InputError(field, 'must be a non-negative decimal with at most 9 places');
  const f = toFixed(s);
  if (cmpFixed(f, toFixed(max)) > 0) throw new InputError(field, `must be at most ${max}`);
  return f;
}

/** Validate everything before any I/O (dev-taste T1). */
export function validateInfer(args, env = {}) {
  if (args === null || typeof args !== 'object') throw new InputError('args', 'must be an object');
  const { tier, model, prompt, budget, max_usd: maxUsd, privacy = 'any', mode = 'quote' } = args;
  if ((tier === undefined) === (model === undefined)) throw new InputError('tier', 'give exactly one of tier or model');
  let target;
  if (tier !== undefined) {
    const t = TIERS.find((x) => x.id === tier);
    if (!t) throw new InputError('tier', `must be one of ${TIERS.map((x) => x.id).join(', ')}`);
    target = t.model;
  } else {
    if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new InputError('model', 'must be 1-120 chars of letters, digits, . _ / : -');
    target = model;
  }
  if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
    throw new InputError('prompt', `must be a string of 1 to ${MAX_PROMPT_CHARS} chars`);
  }
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_BUDGET_TOKENS) {
    throw new InputError('budget', `must be an integer number of output tokens from 1 to ${MAX_BUDGET_TOKENS}`);
  }
  const callCap = decimal('max_usd', maxUsd, HARD_CALL_CAP_USD);
  if (!PRIVACY.includes(privacy)) throw new InputError('privacy', `must be one of ${PRIVACY.join(', ')}`);
  if (!MODES.includes(mode)) throw new InputError('mode', `must be one of ${MODES.join(', ')}`);
  const dailyCap = decimal('JUSTWEIGHT_DAILY_CAP_USD', env.JUSTWEIGHT_DAILY_CAP_USD ?? DEFAULT_DAILY_CAP_USD, HARD_DAILY_CAP_USD);
  // Conservative: 3 UTF-8 bytes per token over-counts input for English and code, so the cap check errs high.
  const inputTokensEst = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3);
  return { tier: tier ?? null, model: target, prompt, budget, callCap, dailyCap, privacy, mode, inputTokensEst };
}

function allowedByPrivacy(o, privacy) {
  const p = o.privacy;
  if (privacy === 'any') return true;
  if (!p) return false; // unknown policy fails closed
  if (privacy === 'local') return p.local === true;
  if (privacy === 'no-retention') return p.local === true || p.noRetention === true;
  if (privacy === 'tee') return p.local === true || p.tee === true || p.e2ee === true;
  return false;
}

/** USD API spend for one offer: USD rows at list price, LOCAL rows at 0, anything else unpriceable. */
function spendOf(o, job) {
  const c = costOf(o, job);
  if (c === null) return null;
  if (o.unit === 'USD') return c;
  if (o.unit === 'LOCAL') return 0n;
  return null;
}

/** Pure routing: rank candidates, apply privacy and both caps, explain every skip. */
export function route(offers, req, spentToday = 0n) {
  const key = canonicalModel(req.model).key;
  const job = { inputTokens: req.inputTokensEst, outputTokens: req.budget };
  const remaining = req.dailyCap - spentToday;
  const ok = [];
  const skipped = [];
  for (const o of offers) {
    if (canonicalModel(o.model).key !== key) continue;
    const id = `${o.provider} ${o.model}`;
    if (!allowedByPrivacy(o, req.privacy)) { skipped.push({ route: id, reason: `privacy ${req.privacy} not met` }); continue; }
    const c = spendOf(o, job);
    if (c === null) { skipped.push({ route: id, reason: o.unit === 'FLOP' ? 'FLOP has no USD price; settle on Flop by receipt instead' : 'no price' }); continue; }
    if (cmpFixed(c, req.callCap) > 0) { skipped.push({ route: id, reason: `quote $${fromFixed(c, 9)} is over max_usd $${fromFixed(req.callCap, 9)}` }); continue; }
    if (cmpFixed(c, remaining) > 0) { skipped.push({ route: id, reason: `quote $${fromFixed(c, 9)} is over the daily cap left ($${fromFixed(remaining, 9)})` }); continue; }
    ok.push({ o, c });
  }
  // Cheapest first; then lower p50 latency; then direct over resold; then name, so ties are deterministic.
  const lat = (x) => x.o.latencyP50Ms ?? Number.MAX_SAFE_INTEGER;
  const resold = (x) => (x.o.provider.startsWith('openrouter') ? 1 : 0);
  ok.sort((a, b) => cmpFixed(a.c, b.c) || lat(a) - lat(b) || resold(a) - resold(b) || a.o.provider.localeCompare(b.o.provider));
  return { chosen: ok[0] ?? null, alternatives: ok.slice(1, 4), skipped };
}

export class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'receipts.jsonl');
  }
  all() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  /** USD actually spent on live calls since UTC midnight. Quotes cost nothing. */
  spentToday(now) {
    const day = now.toISOString().slice(0, 10);
    let s = 0n;
    for (const r of this.all()) if (r.ts.slice(0, 10) === day && r.status === 'completed') s += toFixed(r.cost.chargedUsd);
    return s;
  }
  append(body) {
    const prev = this.all().at(-1)?.hash ?? null;
    const r = { ...body, prev };
    r.hash = sha256(canonicalJson(r));
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.file, JSON.stringify(r) + '\n', { mode: 0o600 });
    return r;
  }
}

/** Recompute every hash and link. Returns the index of the first bad receipt, or -1. */
export function verifyReceipts(receipts) {
  let prev = null;
  for (let i = 0; i < receipts.length; i++) {
    const { hash, ...rest } = receipts[i];
    if (rest.prev !== prev || sha256(canonicalJson(rest)) !== hash) return i;
    prev = hash;
  }
  return -1;
}

function localTarget(env) {
  const url = env.JUSTWEIGHT_LOCAL_URL ?? 'http://127.0.0.1:11434/v1';
  let u;
  try { u = new URL(url); } catch { throw new InputError('JUSTWEIGHT_LOCAL_URL', 'not a URL'); }
  // Live calls go only to this machine. Anything else would be a paid or keyed venue.
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) {
    throw new InputError('JUSTWEIGHT_LOCAL_URL', 'must be http on 127.0.0.1, localhost or [::1], with no credentials');
  }
  const model = env.JUSTWEIGHT_LOCAL_MODEL;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    throw new InputError('JUSTWEIGHT_LOCAL_MODEL', 'set it to the model name your local server uses (e.g. your Ollama tag)');
  }
  return { base: url.replace(/\/+$/, ''), model };
}

/**
 * One infer call. `load()` returns a snapshot; `fetchImpl` is only used for the local model in live mode.
 * Returns { ok, output, receipt, alternatives, skipped } or throws InputError before any I/O on bad input.
 */
export async function infer(args, { load, fetchImpl = globalThis.fetch, env = process.env, now = () => new Date(), ledgerDir } = {}) {
  const req = validateInfer(args, env);
  const ledger = new Ledger(ledgerDir ?? env.JUSTWEIGHT_HOME ?? join(homedir(), '.justweight'));
  if (req.mode === 'live') localTarget(env); // config errors surface before the snapshot fetch
  const snap = await load();
  const t = now();
  const spent = ledger.spentToday(t);
  const r = route(snap.offers, req, spent);
  const base = {
    v: RECEIPT_V,
    id: randomUUID(),
    ts: t.toISOString(),
    mode: req.mode,
    request: {
      tier: req.tier, model: req.model, privacy: req.privacy, budget: req.budget,
      maxUsd: fromFixed(req.callCap, 9), promptSha256: sha256(req.prompt), inputTokensEst: req.inputTokensEst,
    },
    caps: { callCapUsd: fromFixed(req.callCap, 9), dailyCapUsd: fromFixed(req.dailyCap, 9), spentTodayUsd: fromFixed(spent, 9) },
    snapshot: { generatedAt: snap.generatedAt ?? null },
  };
  const view = (x) => ({ provider: x.o.provider, model: x.o.model, unit: x.o.unit, quotedUsd: fromFixed(x.c, 9), latencyP50Ms: x.o.latencyP50Ms ?? null, source: x.o.source });
  if (!r.chosen) {
    const receipt = ledger.append({ ...base, status: 'refused', reason: 'no route meets privacy and caps', route: null, cost: { quotedUsd: null, chargedUsd: '0' }, outputSha256: null });
    return { ok: false, output: null, receipt, alternatives: [], skipped: r.skipped };
  }
  const c = r.chosen;
  const routeView = { ...view(c), inPer1M: c.o.inPer1M, outPer1M: c.o.outPer1M, notes: c.o.notes ?? [] };
  if (req.mode === 'quote') {
    const receipt = ledger.append({ ...base, status: 'quoted', route: routeView, cost: { quotedUsd: fromFixed(c.c, 9), chargedUsd: '0' }, outputSha256: null });
    return { ok: true, output: null, receipt, alternatives: r.alternatives.map(view), skipped: r.skipped };
  }
  // live: only a zero-cost local venue may run. Everything else would need a key we refuse to hold.
  if (c.o.unit !== 'LOCAL') {
    const receipt = ledger.append({ ...base, status: 'refused', reason: 'live calls run only on a local model; paid venues are quote-only (no keys held)', route: routeView, cost: { quotedUsd: fromFixed(c.c, 9), chargedUsd: '0' }, outputSha256: null });
    return { ok: false, output: null, receipt, alternatives: r.alternatives.map(view), skipped: r.skipped };
  }
  const { base: url, model } = localTarget(env);
  const res = await fetchImpl(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: req.prompt }], max_tokens: req.budget, stream: false }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const receipt = ledger.append({ ...base, status: 'failed', reason: `local HTTP ${res.status}`, route: routeView, cost: { quotedUsd: '0', chargedUsd: '0' }, outputSha256: null });
    return { ok: false, output: null, receipt, alternatives: [], skipped: r.skipped };
  }
  const body = await res.json();
  const output = body?.choices?.[0]?.message?.content;
  if (typeof output !== 'string') {
    const receipt = ledger.append({ ...base, status: 'failed', reason: 'local reply had no message content', route: routeView, cost: { quotedUsd: '0', chargedUsd: '0' }, outputSha256: null });
    return { ok: false, output: null, receipt, alternatives: [], skipped: r.skipped };
  }
  const usage = body.usage && Number.isSafeInteger(body.usage.prompt_tokens) && Number.isSafeInteger(body.usage.completion_tokens)
    ? { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens }
    : null;
  const receipt = ledger.append({
    ...base, status: 'completed', route: { ...routeView, localModel: model },
    cost: { quotedUsd: '0', chargedUsd: '0', usage, note: 'local API cost 0; electricity and hardware not counted' },
    outputSha256: sha256(output),
  });
  return { ok: true, output, receipt, alternatives: [], skipped: r.skipped };
}
