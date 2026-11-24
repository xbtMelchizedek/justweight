// FLOP Network sources. Docs: https://docs.flop.network/docs/sdk-references (gateway catalog),
// explorer price index (FRCR "reference index", methodology v1-draft) and the testnet explorer.
import { toFixed, fromFixed, mulFixed, medianFixed } from '../core.mjs';

export const GATEWAY_URL = 'https://api.flop.network/v1/models';
export const PRICE_INDEX_URL = 'https://explorer.devnet.flop.network/api/price-index/v1/preview';
export const TESTNET_MODELS_URL = 'https://testnet.flopscan.io/api/models';
// Devnet genesis pinned in flopscan/flop-preflight and served by https://faucet.flop.network/chain.
export const DEVNET_GENESIS = '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631';
// Testnet genesis as served by testnet.flopscan.io (Flop Labs' explorer) on 2026-11-24.
export const TESTNET_GENESIS = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
export const TESTNET_PRICE_INDEX_URL = 'https://testnet.flopscan.io/api/price-index/v1/preview';
const GENESIS = { devnet: DEVNET_GENESIS, testnet: TESTNET_GENESIS };

const PER_1M = toFixed(1_000_000);

/**
 * Gateway catalog -> FLOP-denominated offers.
 * Price = flop_per_gn x gn_per_token, median across the miners' signed price sources.
 * The OpenRouter-style `pricing` field is cross-checked (method two) and any mismatch is a note, not a silent pick.
 */
export function parseGateway(body) {
  if (!body || !Array.isArray(body.data)) throw new Error('gateway: no data array');
  const offers = [];
  for (const m of body.data) {
    const x = m['x-flop'] ?? {};
    const ps = Array.isArray(x.price_sources) ? x.price_sources : [];
    if (ps.length === 0) continue; // a model with no signed price has no quote
    const perTok = (leg) =>
      medianFixed(ps.map((p) => fromFixed(mulFixed(toFixed(p.flop_per_gn), toFixed(p[leg])), 24)));
    const inTok = perTok('gn_per_prompt_token');
    const outTok = perTok('gn_per_completion_token');
    if (inTok === null || outTok === null) continue;
    const kinds = [...new Set(ps.map((p) => p.source))].sort();
    const devnet = kinds.some((k) => /devnet/i.test(k)) || /devnet/i.test(m.name ?? '');
    const notes = [];
    const nominalUsd = [...new Set(ps.map((p) => p.flop_usd))];
    if (devnet) notes.push('devnet FLOP has no value and earns nothing');
    notes.push(`price source: ${kinds.join(', ')}; ${ps.length} miner quote(s)`);
    if (nominalUsd.length) notes.push(`feed flop_usd=${nominalUsd.join('/')} is nominal, not a market rate; not used`);
    const listed = toFixed(m.pricing?.prompt);
    const implied = mulFixed(inTok, toFixed(nominalUsd[0] ?? null));
    if (listed !== null && implied !== null && listed !== implied) {
      notes.push(`pricing.prompt ${m.pricing.prompt} disagrees with signed sources (${fromFixed(implied, 18)})`);
    }
    const exp = ps.map((p) => p.expires_at).filter(Boolean).sort()[0] ?? null;
    offers.push({
      provider: 'flop-gateway',
      network: devnet ? 'devnet' : 'unknown',
      model: m.id,
      unit: 'FLOP',
      inPer1M: fromFixed(mulFixed(inTok, PER_1M), 12),
      outPer1M: fromFixed(mulFixed(outTok, PER_1M), 12),
      gnPerToken: { in: ps[0].gn_per_prompt_token, out: ps[0].gn_per_completion_token },
      expiresAt: exp,
      capacityTpm: x.capacity_tpm ?? null,
      notes,
      source: GATEWAY_URL,
    });
  }
  return offers;
}

/**
 * Explorer price index -> the realized FLOP per G_n over the last complete, observed hour.
 * This is what miners were actually paid (net miner revenue), read from settled channels, so it is
 * receipts-grade evidence, unlike the list price. Methodology is a draft and not settlement grade.
 */
export function parsePriceIndex(body, network = 'devnet') {
  if (!body || !Array.isArray(body.records)) throw new Error('price index: no records');
  if (!GENESIS[network]) throw new Error(`price index: unknown network ${network}`);
  if (body.genesisHash !== GENESIS[network]) {
    throw new Error(`price index: genesis ${body.genesisHash} is not the pinned ${network} genesis`);
  }
  const done = body.records.filter((r) => r.complete && r.status === 'observed' && r.observedPriceFlopPerGn);
  const last = done[done.length - 1];
  if (!last) return null;
  return {
    network,
    unit: body.unit ?? null,
    methodology: `${body.methodologyVersion ?? '?'} (${body.methodologyStatus ?? '?'})`,
    settlementGrade: body.settlementGrade === true,
    window: { start: last.start, end: last.end },
    flopPerGn: last.observedPriceFlopPerGn,
    trades: last.trades,
    buyers: last.distinctBuyers,
    sellers: last.distinctSellers,
    floorsPassed: last.diagnosticFloorsPassed === true,
    topSellerVolumeShare: last.topSellerVolumeShare ?? null,
    receiptId: last.receiptId ?? null,
    source: network === 'testnet' ? TESTNET_PRICE_INDEX_URL : PRICE_INDEX_URL,
  };
}

/** Realized offers: the index price applied to each gateway model's G_n per token. */
export function realizedOffers(gatewayOffers, index) {
  if (!index || index.floorsPassed !== true) return [];
  const p = toFixed(index.flopPerGn);
  return gatewayOffers
    .filter((o) => o.network === index.network && o.gnPerToken)
    .map((o) => ({
      provider: 'flop-realized',
      network: index.network,
      model: o.model,
      unit: 'FLOP',
      inPer1M: fromFixed(mulFixed(mulFixed(p, toFixed(o.gnPerToken.in)), PER_1M), 12),
      outPer1M: fromFixed(mulFixed(mulFixed(p, toFixed(o.gnPerToken.out)), PER_1M), 12),
      notes: [
        `realized net miner revenue ${index.flopPerGn} FLOP/G_n, ${index.window.start} to ${index.window.end}`,
        `${index.trades} trades, ${index.buyers} buyers, ${index.sellers} sellers; top seller ${index.topSellerVolumeShare}`,
        `composite across models; methodology ${index.methodology}; receipt ${index.receiptId}`,
      ],
      source: index.source,
    }));
}

/** Testnet explorer status. Reports what is there; an empty catalog is a fact, not an error. */
export function parseTestnet(body) {
  if (!body || !Array.isArray(body.models)) throw new Error('testnet: no models array');
  return {
    network: 'testnet',
    genesisHash: body.genesisHash ?? null,
    finalizedHead: body.head?.number ?? null,
    models: body.models.length,
    gateway: body.gateway?.url ?? null,
    source: TESTNET_MODELS_URL,
  };
}
