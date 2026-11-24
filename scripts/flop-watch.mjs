// Print where the testnet FLOP column stands, from a built snapshot. The Pages workflow appends this to its
// run summary every 2 hours. Informational: it never fails the build.
import { readFileSync } from 'node:fs';

const snap = JSON.parse(readFileSync(process.argv[2] ?? 'web/data/snapshot.json', 'utf8'));
const w = snap.flop?.watch;
const flopCells = (snap.offers ?? []).filter((o) => o.provider === 'flop-realized' && o.network === 'testnet');
console.log(`### FLOP testnet watcher (${snap.generatedAt})`);
console.log(w ? `- stage: **${w.stage}**: ${w.detail}` : '- stage: unknown (snapshot has no watch block)');
for (const o of flopCells) console.log(`- ${o.model}: ${o.inPer1M} in / ${o.outPer1M} out FLOP per 1M tokens (${o.source})`);
