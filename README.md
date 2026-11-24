# justweight

**Live:** https://xbtmelchizedek.github.io/justweight/ · **For agents:** [skill.md](skill.md) · MCP: `node src/mcp.mjs`

Quote one inference job (model, input tokens, output tokens) across FLOP, Bittensor (Chutes, subnet 64), Pearl Research Labs and OpenRouter, and see the cheapest route with every price linked to its source.

> "A false balance is abomination to the LORD: but a just weight is his delight." Proverbs 11:1

It is read-only. It never signs, never pays, never claims from a faucet and holds no key. Unaffiliated with Flop Labs, Pearl Research Labs, Chutes or OpenRouter.

## Why

Agents that pay for their own inference need one question answered before every job: where is this model cheapest right now, and how do I know? Each network prices differently: FLOP in FLOP per G_n, Chutes in USD and TAO per 1M tokens, Pearl in USD per 1M, OpenRouter in USD per token. justweight puts them on one scale for the same model and refuses to make up the parts nobody publishes.

## Use

```sh
node src/cli.mjs quote --model qwen/qwen3.8-27b --in 100000 --out 20000   # live
node src/cli.mjs quote --model qwen3-14b --in 1000 --out 1000 --snapshot web/data/snapshot.json
node src/cli.mjs models
node src/cli.mjs sources
npm test
```

Node 22+, no dependencies. Exit codes: 0 ok, 1 no provider lists the model, 2 bad input or no data. Bad input is rejected before any network call.

MCP (stdio, read-only tools `justweight_quote`, `justweight_models`, `justweight_sources`; reads the published snapshot unless `live: true`):

```json
{ "mcpServers": { "justweight": { "command": "node", "args": ["/path/to/justweight/src/mcp.mjs"] } } }
```

The page has "Open in your agent" buttons (Cursor, Grok Bot, Claude, Claude Code, ChatGPT, Codex, T3 Code) that open a draft prompt telling the agent how to use justweight. They come from [agent-deeplinks](https://github.com/lalalune/agent-deeplinks) by Shaw (MIT, vendored unmodified in `web/vendor/agent-deeplinks/`). Links only prefill; nothing auto-sends.

## Sources

| id | URL | unit | notes |
|---|---|---|---|
| flop-gateway | https://api.flop.network/v1/models | FLOP | `flop_per_gn x gn_per_token`, median of miners' signed price sources, cross-checked against the catalog's `pricing` field. Today this catalog is devnet. |
| flop-price-index | https://explorer.devnet.flop.network/api/price-index/v1/preview | FLOP/G_n | realized net miner revenue over the last complete hour from settled channels. Genesis pinned. Used only when its own floors pass. |
| flop-testnet | https://testnet.flopscan.io/api/models | status | testnet registry and gateway. Empty on 2026-11-24 (no models, no gateway yet). |
| chutes-bittensor | https://llm.chutes.ai/v1/models | USD (+TAO) | Chutes list price per 1M |
| pearl-labs | https://pearlresearch.ai/pricing | USD | public pricing page, parsed; zero rows is an error |
| openrouter | https://openrouter.ai/api/v1/models | USD | list price per token, scaled to 1M; `-1` sentinel dropped |
| coingecko | https://api.coingecko.com/api/v3/simple/price | rates | TAO and PRL in USD. FLOP has no market price and is never converted. |

## Rules it follows

- Missing data is an error, never zero. A dead source is reported in `sources` and the rest still quote.
- Exact decimal math (BigInt, 1e-24) so per-token prices do not drift.
- Units are never mixed without a cited rate. FLOP stays in FLOP.
- Variants (TEE, FP8, batch) are kept visible: they match the model for comparison but are not the same artifact.

## License

MIT. Vendored: agent-deeplinks (MIT, Shaw) and Arc UI foundation tokens (MIT, see `web/arc/LICENSE`).
