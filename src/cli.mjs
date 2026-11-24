#!/usr/bin/env node
// justweight CLI. Read-only: it never signs, never spends and holds no key.
import { readFileSync } from 'node:fs';
import { quote, listModels, validateJob, InputError } from './core.mjs';
import { fetchAll, usableRates } from './fetchAll.mjs';
import { iuTable } from './tiers.mjs';

const HELP = `justweight: quote one inference job across FLOP, Pearl, Venice, Bittensor (Chutes), OpenRouter and local.

  justweight quote --model <id> --in <tokens> --out <tokens> [--snapshot file|url]
  justweight models [--snapshot file|url]
  justweight tiers [--snapshot file|url]    # 1 IU (750k in + 250k out) per tier and venue
  justweight sources [--snapshot file|url]
  justweight snapshot                  # fetch every source live, print the snapshot JSON

Without --snapshot it fetches live. Output is JSON. Exit 0 ok, 1 no priced match, 2 bad input or no data.`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new InputError('args', `unexpected ${a}`);
    const k = a.slice(2);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new InputError(k, 'needs a value');
    opts[k] = v;
    i++;
  }
  return { cmd, opts };
}

const toInt = (field, v) => {
  if (v === undefined) return 0;
  if (!/^\d+$/.test(v)) throw new InputError(field, 'must be a whole number');
  return Number(v);
};

async function loadSnapshot(src, fetchImpl) {
  if (!src) return fetchAll({ fetchImpl });
  if (/^https:\/\//.test(src)) {
    const r = await fetchImpl(src, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(src, 'utf8'));
}

export async function main(argv, { fetchImpl = globalThis.fetch, out = console.log } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (!parsed.cmd || parsed.cmd === 'help' || parsed.cmd === '--help') {
      out(HELP);
      return parsed.cmd ? 0 : 2;
    }
    if (parsed.cmd === 'quote') {
      // Validate before any network call (dev-taste T1).
      validateJob({
        model: parsed.opts.model,
        inputTokens: toInt('in', parsed.opts.in),
        outputTokens: toInt('out', parsed.opts.out),
      });
    } else if (!['models', 'sources', 'snapshot', 'tiers'].includes(parsed.cmd)) {
      throw new InputError('command', `unknown ${parsed.cmd}`);
    }
  } catch (e) {
    out(JSON.stringify({ ok: false, error: e.message }));
    return 2;
  }
  const { cmd, opts } = parsed;
  let snap;
  try {
    snap = await loadSnapshot(cmd === 'snapshot' ? undefined : opts.snapshot, fetchImpl);
  } catch (e) {
    out(JSON.stringify({ ok: false, error: `could not load prices: ${e.message}` }));
    return 2;
  }
  if (cmd === 'snapshot') {
    out(JSON.stringify(snap, null, 1));
    return snap.offers.length ? 0 : 2;
  }
  if (cmd === 'sources') {
    out(JSON.stringify({ generatedAt: snap.generatedAt, sources: snap.sources, rates: snap.rates, flop: snap.flop }, null, 1));
    return 0;
  }
  if (cmd === 'tiers') {
    out(JSON.stringify({ ok: true, generatedAt: snap.generatedAt, ...iuTable(snap.offers, { testnet: snap.flop?.testnet }) }, null, 1));
    return 0;
  }
  if (cmd === 'models') {
    out(JSON.stringify(listModels(snap.offers), null, 1));
    return 0;
  }
  const q = quote(
    snap.offers,
    { model: opts.model, inputTokens: toInt('in', opts.in), outputTokens: toInt('out', opts.out) },
    usableRates(snap.rates),
  );
  const failed = snap.sources.filter((s) => !s.ok).map((s) => s.id);
  out(JSON.stringify({ ok: true, generatedAt: snap.generatedAt, failedSources: failed, ...q }, null, 1));
  return q.matched ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/justweight')) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
