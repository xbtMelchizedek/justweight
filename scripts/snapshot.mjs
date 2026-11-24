// Build web/data/snapshot.json from live sources. Run by the Pages workflow; fails if nothing priced.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetchAll } from '../src/fetchAll.mjs';

const out = process.argv[2] ?? 'web/data/snapshot.json';
const snap = await fetchAll();
mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(out, JSON.stringify(snap));
const ok = snap.sources.filter((s) => s.ok).length;
console.log(`${snap.offers.length} offers from ${ok}/${snap.sources.length} sources -> ${out}`);
for (const s of snap.sources) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.id}${s.ok ? '' : ': ' + s.error}`);
if (snap.offers.length === 0) process.exit(1);
