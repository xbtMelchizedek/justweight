---
name: justweight
description: Find the cheapest provider for one inference job across FLOP, Pearl, Venice, Bittensor (Chutes), each OpenRouter provider and local models, with every price cited. Read-only; never signs or spends.
---

# justweight: quote an inference job

Use this when you need to pick where to run a model call by price. justweight only reads public price lists. It never signs, pays, claims or holds a key, and neither should you while using it.

## Fastest path (no install)

1. `GET https://xbtmelchizedek.github.io/justweight/data/snapshot.json` (rebuilt every 2 hours by CI; check `generatedAt`).
2. In `offers`, keep rows whose model matches yours after lowercasing, dropping the `org/` prefix and the suffixes `-tee -fp8 -bf16 -nvfp4 -turbo -fast` and anything after `:` (those are serving variants; say which one you picked).
3. Job cost = `inputTokens * inPer1M / 1e6 + outputTokens * outPer1M / 1e6`, in the row's `unit`.
4. Rank `unit: "USD"` rows. `unit: "LOCAL"` rows run on your own hardware (API cost 0, power not counted). Do **not** convert `unit: "FLOP"` rows to USD: FLOP has no market price (`rates.FLOP.usd` is null). Report FLOP rows separately in FLOP.
5. Cite each row's `source` URL and its `notes` (devnet, TEE, launch pricing, batch tier).
6. If a source in `sources` has `ok: false`, say so; its prices are missing, not zero.

## CLI and MCP

```sh
git clone https://github.com/xbtMelchizedek/justweight && cd justweight   # Node 22+, no dependencies
node src/cli.mjs quote --model qwen/qwen3.8-27b --in 100000 --out 20000   # live fetch
node src/cli.mjs quote --model qwen3-14b --in 1000 --out 1000 --snapshot https://xbtmelchizedek.github.io/justweight/data/snapshot.json
node src/cli.mjs models | node src/cli.mjs sources
```

MCP (stdio), read-only tools `justweight_quote`, `justweight_models`, `justweight_tiers`, `justweight_sources`:

```json
{ "mcpServers": { "justweight": { "command": "node", "args": ["/path/to/justweight/src/mcp.mjs"] } } }
```

## What the numbers mean

- `flop-gateway`: FLOP per token = `flop_per_gn x gn_per_token`, median of the miners' signed price sources on `api.flop.network/v1/models`. Today that catalog is **devnet** (`devnet-nominal`), and devnet FLOP has no value.
- `flop-realized`: what miners were actually paid per G_n over the last complete hour on the devnet explorer price index (settled channels, draft methodology), applied to each model's G_n per token. Shown only when the index's own trade/buyer/seller floors pass.
- `chutes-bittensor`: Chutes (Bittensor subnet 64) list price in USD; TAO price in notes.
- `pearl-labs`: Pearl Research Labs public pricing page (USD, "special launch pricing"). Paid in USD, not PRL.
- `openrouter`: OpenRouter list price in USD (OpenRouter picks the provider).
- `openrouter:<provider>/<tag>`: one OpenRouter provider (e.g. `openrouter:pearl-research/fp8`). `effective` is OpenRouter's published price after cache hits; `latencyP50Ms` is the last 30 minutes; `privacy.noRetention` is true for ZDR endpoints.
- `venice`: Venice list price in USD (1 DIEM = $1 of daily credit while staked; x402 USDC per request also works). `privacy` carries Venice's private/anonymized label and E2EE/TEE flags.
- `local`: a model on your own machine (Inkling 2 Mini). Cost 0 in unit LOCAL.
- `node src/cli.mjs tiers`: 1 IU = 750k in + 250k out of a tier's reference model, cheapest per venue.
- `sources[].id == "flop-testnet"` / `flop.testnet`: the FLOP testnet registry. When it lists models and a gateway, testnet routes appear here.

## infer (MCP)

`infer` picks the cheapest venue for a tier (`mini`, `mid`, `flash`) or model under your `privacy` rule and `max_usd` (at most $0.50 a call; daily cap default $1). Default `mode: "quote"` spends nothing. `mode: "live"` only runs a local model on 127.0.0.1. Every call returns a receipt with a hash chained to the previous one; keep it as your proof of what was chosen and why.
