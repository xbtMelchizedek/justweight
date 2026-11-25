import { fromFixed, toFixed } from '../core.mjs';

export const DEEPINFRA_URL = 'https://api.deepinfra.com/models/list';

export function parseDeepInfra(body) {
  if (!Array.isArray(body)) throw new Error('deepinfra: expected a model list');
  const offers = [];
  for (const model of body) {
    if (model?.type !== 'text-generation' || model.private || model.deprecated || !model.model_name) continue;
    const pricing = model.pricing;
    if (pricing?.type !== 'tokens') continue;
    const input = toFixed(pricing.cents_per_input_token);
    const output = toFixed(pricing.cents_per_output_token);
    if (input === null || output === null || input < 0n || output < 0n) continue;
    const discount = toFixed(pricing.discount ?? 0);
    const one = toFixed(1);
    if (discount === null || discount < 0n || discount > one) continue;
    // One million tokens at one cent per token costs 10,000 USD.
    const perMillion = cents => fromFixed(cents * 10_000n * (one - discount) / one);
    offers.push({
      provider: 'deepinfra',
      network: null,
      model: model.model_name,
      unit: 'USD',
      inPer1M: perMillion(input),
      outPer1M: perMillion(output),
      notes: ['DeepInfra catalog rates including any published discount; excludes caching and service-tier adjustments'],
      source: DEEPINFRA_URL,
    });
  }
  if (!offers.length) throw new Error('deepinfra: no priced text models');
  return offers;
}
