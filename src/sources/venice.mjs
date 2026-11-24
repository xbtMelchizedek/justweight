// Venice (VVV / DIEM). Public model list with USD and DIEM prices per 1M tokens.
// Docs: https://docs.venice.ai/overview/vvv-diem (1 DIEM = $1/day of credit while staked) and x402 USDC.
import { toFixed } from '../core.mjs';

export const VENICE_URL = 'https://api.venice.ai/api/v1/models';

// Venice ids don't follow OpenRouter's author/slug form. This table maps the ones we compare to the
// OpenRouter id of the same model. Hand-checked against each model's description on 2026-11-24.
// Anything not listed keeps a venice/ prefix, so it only ever matches itself.
export const VENICE_ALIASES = {
  'qwen-3-8-27b': 'qwen/qwen3.8-27b',
  'e2ee-qwen3-8-27b': 'qwen/qwen3.8-27b:e2ee',
  'deepseek-v4-1-flash-1017': 'deepseek/deepseek-v4.1-flash-1017',
  'deepseek-v4-1-flash-1017-ultrafast': 'deepseek/deepseek-v4.1-flash-1017:ultrafast',
  'deepseek-v4-pro-0813': 'deepseek/deepseek-v4-pro-0813',
  'inkling-2-mini': 'thinkingmachines/inkling-2-mini',
  'openai-gpt-oss-120b': 'openai/gpt-oss-120b',
  'google-gemma-4-31b-it': 'google/gemma-4-31b-it',
  'qwen3-6-27b': 'qwen/qwen3.6-27b',
  'llama-3.3-70b': 'meta-llama/llama-3.3-70b-instruct',
};

export function parseVenice(body) {
  if (!body || !Array.isArray(body.data)) throw new Error('venice: no data array');
  const out = [];
  for (const m of body.data) {
    if (m.type !== 'text') continue;
    const spec = m.model_spec ?? {};
    const p = spec.pricing ?? {};
    const inUsd = p.input?.usd;
    const outUsd = p.output?.usd;
    if (toFixed(inUsd) === null || toFixed(outUsd) === null) continue;
    if (spec.offline === true) continue;
    const caps = spec.capabilities ?? {};
    const notes = [`Venice list price; DIEM per 1M: in ${p.input?.diem ?? '?'}, out ${p.output?.diem ?? '?'}`];
    if (p.cache_input?.usd !== undefined) notes.push(`cached input ${p.cache_input.usd}/1M`);
    notes.push(`Venice privacy label: ${spec.privacy ?? 'unknown'}`);
    if (caps.supportsE2EE) notes.push('end-to-end encrypted');
    if (caps.supportsTeeAttestation) notes.push('TEE attestation');
    notes.push('payable in USD, staked DIEM, or USDC per request via x402');
    out.push({
      provider: 'venice',
      network: null,
      model: VENICE_ALIASES[m.id] ?? `venice/${m.id}`,
      veniceId: m.id,
      unit: 'USD',
      inPer1M: String(inUsd),
      outPer1M: String(outUsd),
      privacy: {
        retention: spec.privacy === 'private' ? 'none (Venice private)' : `Venice ${spec.privacy ?? 'unknown'}`,
        noRetention: spec.privacy === 'private',
        tee: caps.supportsTeeAttestation === true,
        e2ee: caps.supportsE2EE === true,
        local: false,
      },
      notes,
      source: VENICE_URL,
    });
  }
  if (out.length === 0) throw new Error('venice: no priced text models');
  return out;
}
