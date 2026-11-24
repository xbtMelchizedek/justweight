#!/usr/bin/env node
// Minimal stdio MCP server (JSON-RPC 2.0, one message per line). Read-only tools only.
import { createInterface } from 'node:readline';
import { quote, listModels, InputError } from './core.mjs';
import { fetchAll, usableRates } from './fetchAll.mjs';

export const SNAPSHOT_URL = 'https://xbtmelchizedek.github.io/justweight/data/snapshot.json';
const PROTOCOL = '2025-06-18';

export const TOOLS = [
  {
    name: 'justweight_quote',
    description:
      'Quote one inference job (model, input and output tokens) across FLOP, Bittensor Chutes, Pearl Labs and OpenRouter. ' +
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
    name: 'justweight_sources',
    description: 'Show each price source, whether it answered, FLOP testnet status, and the realized FLOP price index.',
    inputSchema: { type: 'object', properties: { live: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

export function makeServer({ fetchImpl = globalThis.fetch, snapshotUrl = SNAPSHOT_URL } = {}) {
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
        serverInfo: { name: 'justweight', version: '0.1.0' },
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
        if (name === 'justweight_quote') {
          // quote() validates; run it on an empty offer list first so bad input never reaches the network.
          quote([], { model: args.model, inputTokens: args.inputTokens, outputTokens: args.outputTokens });
        }
        const snap = await load(args.live === true);
        if (name === 'justweight_models') return reply(text(listModels(snap.offers)));
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
