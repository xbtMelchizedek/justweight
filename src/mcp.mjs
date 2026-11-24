#!/usr/bin/env node
// Minimal stdio MCP server (JSON-RPC 2.0, one message per line). Price tools are read-only; `infer` quotes
// by default and only ever runs a model on this machine (see src/infer.mjs).
import { createInterface } from 'node:readline';
import { quote, listModels, InputError } from './core.mjs';
import { fetchAll, usableRates } from './fetchAll.mjs';
import { iuTable, TIERS } from './tiers.mjs';
import { infer, PRIVACY, HARD_CALL_CAP_USD, MAX_BUDGET_TOKENS } from './infer.mjs';

export const SNAPSHOT_URL = 'https://xbtmelchizedek.github.io/justweight/data/snapshot.json';
const PROTOCOL = '2025-06-18';

export const TOOLS = [
  {
    name: 'justweight_quote',
    description:
      'Quote one inference job (model, input and output tokens) across FLOP, Pearl, Venice, Bittensor Chutes, each OpenRouter provider and local models. ' +
      'Returns the cheapest USD-priced route, every match, and FLOP routes that have no USD price. Read-only; spends nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id, e.g. qwen/qwen3.8-27b' },
        inputTokens: { type: 'integer', minimum: 0 },
        outputTokens: { type: 'integer', minimum: 0 },
        live: { type: 'boolean', description: 'Fetch every source now instead of the published snapshot' },
      },
      required: ['model', 'inputTokens', 'outputTokens'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'justweight_models',
    description: 'List comparable models and which providers list each one.',
    inputSchema: { type: 'object', properties: { live: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'justweight_tiers',
    description:
      'Standard-unit table: cost of 1 IU (750k input + 250k output tokens of a tier reference model) at the cheapest offer per venue (FLOP, Pearl, Chutes, Venice, OpenRouter, local), list and effective. Read-only.',
    inputSchema: { type: 'object', properties: { live: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'justweight_sources',
    description: 'Show each price source, whether it answered, FLOP testnet status, and the realized FLOP price index.',
    inputSchema: { type: 'object', properties: { live: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'infer',
    description:
      'Route one inference call to the cheapest venue that meets your privacy rule and spend caps, and return a hash-chained receipt. ' +
      'mode "quote" (default) spends nothing and returns the chosen venue, the quote and alternatives. ' +
      'mode "live" runs only on a local model at 127.0.0.1 (set JUSTWEIGHT_LOCAL_MODEL); paid venues are never called because justweight holds no keys. ' +
      `max_usd is capped at $${HARD_CALL_CAP_USD} per call; a daily cap (default $1, JUSTWEIGHT_DAILY_CAP_USD) also applies.`,
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: TIERS.map((t) => t.id), description: 'Size tier; give tier or model' },
        model: { type: 'string', description: 'Exact model id instead of a tier' },
        prompt: { type: 'string' },
        budget: { type: 'integer', minimum: 1, maximum: MAX_BUDGET_TOKENS, description: 'Max output tokens' },
        max_usd: { type: 'string', description: `Hard ceiling for this call in USD, decimal string, at most ${HARD_CALL_CAP_USD}` },
        privacy: { type: 'string', enum: PRIVACY, default: 'any' },
        mode: { type: 'string', enum: ['quote', 'live'], default: 'quote' },
        live_prices: { type: 'boolean', description: 'Fetch prices live instead of the published snapshot' },
      },
      required: ['prompt', 'budget', 'max_usd'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

export function makeServer({ fetchImpl = globalThis.fetch, snapshotUrl = SNAPSHOT_URL, env = process.env, ledgerDir } = {}) {
  const load = async (live) => {
    if (live) return fetchAll({ fetchImpl });
    const r = await fetchImpl(snapshotUrl, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
    return r.json();
  };
  const text = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }], isError });

  return async function handle(msg) {
    const { id, method, params } = msg ?? {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'initialize') {
      return reply({
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'justweight', version: '0.3.0' },
      });
    }
    if (method?.startsWith('notifications/')) return null;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool ${name}`);
      try {
        if (name === 'infer') {
          const { live_prices: lp, ...a } = args;
          return reply(text(await infer(a, { load: () => load(lp === true), fetchImpl, env, ledgerDir })));
        }
        if (name === 'justweight_quote') {
          // quote() validates; run it on an empty offer list first so bad input never reaches the network.
          quote([], { model: args.model, inputTokens: args.inputTokens, outputTokens: args.outputTokens });
        }
        const snap = await load(args.live === true);
        if (name === 'justweight_models') return reply(text(listModels(snap.offers)));
        if (name === 'justweight_tiers') {
          return reply(text({ generatedAt: snap.generatedAt, ...iuTable(snap.offers, { testnet: snap.flop?.testnet }) }));
        }
        if (name === 'justweight_sources') {
          return reply(text({ generatedAt: snap.generatedAt, sources: snap.sources, rates: snap.rates, flop: snap.flop }));
        }
        const q = quote(
          snap.offers,
          { model: args.model, inputTokens: args.inputTokens, outputTokens: args.outputTokens },
          usableRates(snap.rates),
        );
        return reply(text({ generatedAt: snap.generatedAt, ...q }));
      } catch (e) {
        return reply(text({ error: e.message, field: e instanceof InputError ? e.field : undefined }, true));
      }
    }
    return id === undefined ? null : fail(-32601, `method not found: ${method}`);
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const handle = makeServer();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    const res = await handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}
