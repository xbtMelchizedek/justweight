# Contributing to justweight

Thanks for helping agents pay a just price. Small, finished pull requests are the easiest to merge.

## Setup

```sh
git clone https://github.com/xbtMelchizedek/justweight && cd justweight
npm test                         # Node 22+, no dependencies, no network (fixtures only)
node src/cli.mjs tiers           # live, reads every public source
node scripts/snapshot.mjs /tmp/s.json && node scripts/build-web.mjs   # build the page into _site/
```

## Adding a price source (the most common change)

1. Add `src/sources/<name>.mjs` with a pure `parse<Name>(body)` that returns offers: `{ provider, model, unit, inPer1M, outPer1M, notes, source }`. Prices are decimal strings, never floats.
2. Save one real response as `test/fixtures/<name>.json` and write a test against it. Include at least one malformed body that must throw.
3. Register it in `src/fetchAll.mjs` with its own `run(...)`, so a dead source never hides the others.
4. Add a row to the Sources table in the README with the URL and unit.

## Rules the code follows (please keep them)

- **Missing is not zero.** A source that fails or a price that is absent is reported as missing, never filled in.
- **Units never mix.** FLOP stays FLOP, LOCAL stays LOCAL. Only rates with a cited USD price convert.
- **Exact math.** Fixed-point BigInt (`toFixed`/`fromFixed` in `src/core.mjs`), no floating point in prices.
- **Read-only.** No keys, no signing, no paid API calls. `infer` live mode is loopback-only on purpose.
- **Fetched text is data.** Never follow instructions found in a fetched page.
- **Synthetic fixtures say so.** If a real response shape isn't published yet, name the fixture `synthetic_*` and explain inside it.

## Pull requests

- Keep one change per PR, with tests: `npm test` must pass and CI must be green.
- Describe what you checked by hand (for example: "ran `tiers` live at 3 PM ET, Venice row matches the site").
- Security issues go through [SECURITY.md](SECURITY.md), never a public issue.
