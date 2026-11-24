# Changelog

All notable changes. Versions follow [semver](https://semver.org); before 1.0, minor versions may change the snapshot shape.

## 0.4.0 (2026-11-24)

- **Testnet watcher.** Each rebuild follows the testnet explorer's advertised gateway (Flop-hosted https only) once models are listed. It prices them from settled receipt hours that pass the index floors and records one readable stage (`explorer-down`, `no-models`, `no-gateway`, `gateway-unreadable`, `no-receipt-hour`, `below-floors`, `filled`) in `snapshot.flop.watch`, on the page and in the Actions run summary.
- **Packaging.** Library entry `src/index.mjs` (`import { quote, iuTable, infer } from 'justweight'`), `exports`, `files`, and bins that work through npm/npx symlinks. The MCP server reports the package version.
- CONTRIBUTING.md, SECURITY.md, this changelog.

## 0.3.0 (2026-11-24)

- `infer` MCP tool: one call routed by tier or model under a privacy rule (`any`, `no-retention`, `tee`, `local`) and hard caps ($0.50 per call, $5 per day). It is quote-only for paid venues and runs live only on a loopback local model. Every call writes a hash-chained receipt.

## 0.2.0 (2026-11-24)

- Venice source, with privacy, E2EE and TEE flags.
- Per-provider OpenRouter rows for each tier model (Pearl included): list price, effective price, cache-hit rate, p50 latency and the zero-data-retention flag.
- Local Inkling 2 Mini venue.
- Testnet price index, with the genesis pinned.
- Standard unit (1 IU = 750k input + 250k output tokens) table for the mini, mid and flash tiers.

## 0.1.0 (2026-11-24)

- First release: a read-only price router across FLOP (gateway and realized price index), Chutes, Pearl and OpenRouter. It has a CLI, an MCP server, a static page rebuilt every 2 hours, and every price linked to its source.
