// Tiered standard unit. 1 IU = the cost of 1M tokens of a tier's reference model at a fixed 3:1 mix
// (750k input + 250k output). One reference model per tier; a venue joins a tier only when it lists that
// exact model. Design: melchizedek_kb/research/PEARL_AND_BRIDGELESS_DESIGN_2026-11-24.md section C1.5.
import { canonicalModel, costOf, fromFixed, cmpFixed } from './core.mjs';

export const IU_JOB = { inputTokens: 750_000, outputTokens: 250_000 };

export const TIERS = [
  { id: 'mini', model: 'thinkingmachines/inkling-2-mini', why: 'smallest open model that runs locally (Apache-2.0)' },
  { id: 'mid', model: 'qwen/qwen3.8-27b', why: 'dense 27B listed by Pearl, Chutes, Venice and OpenRouter' },
  { id: 'flash', model: 'deepseek/deepseek-v4.1-flash-1017', why: 'where most of Pearl\'s OpenRouter volume is' },
];

// Columns. Each maps an offer to one venue; the cheapest offer per venue fills the cell.
export const VENUES = [
  { id: 'flop', label: 'FLOP (receipts)', match: (o) => o.provider === 'flop-realized' },
  { id: 'pearl', label: 'Pearl', match: (o) => o.provider === 'pearl-labs' || o.provider.startsWith('openrouter:pearl-research') },
  { id: 'chutes', label: 'Chutes (Bittensor)', match: (o) => o.provider === 'chutes-bittensor' || o.provider.startsWith('openrouter:chutes') },
  { id: 'venice', label: 'Venice', match: (o) => o.provider === 'venice' },
  { id: 'openrouter', label: 'OpenRouter (any provider)', match: (o) => o.provider === 'openrouter' || o.provider.startsWith('openrouter:') },
  { id: 'local', label: 'Local', match: (o) => o.provider === 'local' },
];

const isResold = (o) => o.provider.startsWith('openrouter');

function iuCost(o, basis) {
  const prices = basis === 'effective' ? o.effective : o;
  if (!prices) return null;
  return costOf({ inPer1M: prices.inPer1M, outPer1M: prices.outPer1M }, IU_JOB);
}

/** Cheapest offer per venue per tier, list and effective. FLOP cells stay in FLOP; nothing is converted. */
export function iuTable(offers, { testnet = null, watch = null } = {}) {
  const rows = [];
  for (const t of TIERS) {
    const key = canonicalModel(t.model).key;
    const mine = offers.filter((o) => canonicalModel(o.model).key === key);
    const cells = {};
    for (const v of VENUES) {
      const cands = mine.filter(v.match);
      let best = null;
      for (const o of cands) {
        const c = iuCost(o, 'list');
        if (c === null) continue;
        // On a tie, prefer buying direct over the same price through a reseller (one fewer middleman).
        const cmp = best ? cmpFixed(c, best.c) : -1;
        if (cmp < 0 || (cmp === 0 && isResold(best.o) && !isResold(o))) best = { o, c };
      }
      let bestEff = null;
      for (const o of cands) {
        const c = iuCost(o, 'effective');
        if (c === null) continue;
        if (!bestEff || cmpFixed(c, bestEff.c) < 0) bestEff = { o, c };
      }
      cells[v.id] = best
        ? {
            list: fromFixed(best.c, 6),
            unit: best.o.unit,
            via: best.o.provider,
            model: best.o.model,
            effective: bestEff ? fromFixed(bestEff.c, 6) : null,
            effectiveVia: bestEff ? bestEff.o.provider : null,
            source: best.o.source,
          }
        : { list: null, reason: v.id === 'flop' ? (watch && watch.stage !== 'filled' ? watch.detail : flopReason(testnet)) : 'not listed' };
    }
    rows.push({ tier: t.id, model: t.model, why: t.why, cells });
  }
  return { unit: '1 IU = 750k input + 250k output tokens of the tier model', job: IU_JOB, venues: VENUES.map(({ id, label }) => ({ id, label })), rows };
}

function flopReason(testnet) {
  if (!testnet) return 'testnet explorer did not answer';
  if (testnet.models === 0) return `testnet has 0 models (finalized block ${testnet.finalizedHead}); no receipts to price from yet`;
  return 'no settled testnet receipts for this model yet';
}

/** IU list cost of one offer as a decimal string, or null. Exported for infer. */
export function iuOf(o) {
  const c = iuCost(o, 'list');
  return c === null ? null : fromFixed(c, 9);
}

