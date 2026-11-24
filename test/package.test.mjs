import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package: library entry exports the public API', async () => {
  const m = await import('../src/index.mjs');
  for (const k of ['quote', 'fetchAll', 'iuTable', 'infer', 'route', 'verifyReceipts', 'flopWatch', 'TIERS', 'SNAPSHOT_URL']) assert.ok(k in m, k);
  assert.equal(pkg.exports['.'], './src/index.mjs');
  assert.ok(pkg.files.includes('src') && !pkg.files.includes('test'));
});

test('package: bins run through an npm-style symlink (npx path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-bin-'));
  const link = join(dir, 'justweight');
  symlinkSync(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), link);
  const r = spawnSync(process.execPath, [link, 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /^justweight: quote one inference job/);
});

test('package: mcp server reports the package version', async () => {
  const { makeServer } = await import('../src/mcp.mjs');
  const res = await makeServer()({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.result.serverInfo.version, pkg.version);
});
