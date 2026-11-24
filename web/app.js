import { quote, listModels } from './core.mjs';
import { getAgentLink, getAgentIcon, agents } from './vendor/agent-deeplinks/index.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SITE = new URL('.', location.href).href;
let snap = null;

function usable(rates) {
  const o = {};
  for (const [k, r] of Object.entries(rates ?? {})) if (r && r.usd !== null) o[k] = r;
  return o;
}

function row(r, best) {
  const cost = r.costUsd !== null ? `$${r.costUsd}` : r.cost !== null ? `${r.cost} ${r.unit}` : 'unknown';
  const price = `${r.inPer1M ?? '?'} / ${r.outPer1M ?? '?'} ${r.unit}`;
  const tags = [r.network, ...(r.variant ?? [])].filter(Boolean).join(', ');
  return `<tr class="${best ? 'best' : ''}"><td>${esc(r.provider)}${best ? ' <span class="badge">cheapest</span>' : ''}<div class="note">${esc(r.model)}${tags ? ' · ' + esc(tags) : ''}</div></td>
  <td class="num">${esc(cost)}</td><td class="num">${esc(price)}</td>
  <td><div class="note">${(r.notes ?? []).map(esc).join('<br>')}</div><a class="note" href="${esc(r.source)}">source</a></td></tr>`;
}

function render(job) {
  let q;
  try {
    q = quote(snap.offers, job, usable(snap.rates));
  } catch (e) {
    $('status').textContent = e.message;
    $('result').innerHTML = '';
    return;
  }
  $('status').textContent = q.matched
    ? `${q.matched} route(s) for ${q.modelKey}. Prices as of ${new Date(snap.generatedAt).toLocaleString()}.`
    : `No provider lists ${q.modelKey}. Pick a model from the list.`;
  if (!q.matched) { $('result').innerHTML = ''; return; }
  const head = '<tr><th>Route</th><th>Job cost</th><th>Per 1M in / out</th><th>Evidence</th></tr>';
  let html = '';
  if (q.ranked.length) html += `<div class="panel wrap"><h2>Priced in USD</h2><table>${head}${q.ranked.map((r, i) => row(r, i === 0)).join('')}</table></div>`;
  if (q.noUsdPrice.length) html += `<div class="panel wrap"><h2>No USD price (FLOP has no market yet)</h2><table>${head}${q.noUsdPrice.map((r) => row(r, false)).join('')}</table></div>`;
  $('result').innerHTML = html;
}

function renderMeta() {
  $('models').innerHTML = listModels(snap.offers).map((m) => `<option value="${esc(m.key)}">${esc(m.providers.join(', '))}</option>`).join('');
  $('sources').innerHTML = '<div class="wrap"><table><tr><th>Source</th><th>State</th><th>Offers</th></tr>' +
    snap.sources.map((s) => `<tr><td><a href="${esc(s.url)}">${esc(s.id)}</a></td><td>${s.ok ? 'answered' : 'failed: ' + esc(s.error)}</td><td class="num">${s.count ?? ''}</td></tr>`).join('') +
    '</table></div>' +
    `<p class="note">Rates: ${Object.values(snap.rates ?? {}).map((r) => `${esc(r.unit)} ${r.usd === null ? 'unknown' : '$' + esc(r.usd)}`).join(' · ')} (CoinGecko). FLOP is never converted to USD.</p>`;
  const t = snap.flop?.testnet, pi = snap.flop?.priceIndex;
  $('flop').innerHTML =
    (t ? `<p>Testnet: finalized block ${esc(t.finalizedHead)}, ${esc(t.models)} model(s) in the registry, gateway ${t.gateway ? esc(t.gateway) : 'not published yet'}. <a href="${esc(t.source)}">source</a></p>` : '<p>Testnet explorer did not answer.</p>') +
    (pi ? `<p>Devnet realized price: ${esc(pi.flopPerGn)} FLOP per G_n (net miner revenue, ${esc(pi.trades)} trades, ${esc(pi.buyers)} buyers, ${esc(pi.sellers)} sellers, ${esc(pi.window.start)} to ${esc(pi.window.end)}). Methodology ${esc(pi.methodology)}. <a href="${esc(pi.source)}">source</a></p>` : '<p>No complete price-index hour.</p>');
}

function renderAgents() {
  const prompt = `Use justweight, a read-only inference price router. Read ${SITE}skill.md, then fetch ${SITE}data/snapshot.json and tell me the cheapest provider for qwen/qwen3.8-27b with 100000 input and 20000 output tokens. Cite each price's source URL. Do not sign, pay or spend anything.`;
  const links = [];
  for (const id of Object.keys(agents)) {
    for (const p of ['web', 'desktop']) {
      const url = getAgentLink(id, p, { prompt });
      if (url) { links.push({ id, p, url }); break; }
    }
  }
  $('agents').innerHTML = links.map(({ id, p, url }) =>
    `<a href="${esc(url)}" rel="noopener"><img alt="" src="${esc(getAgentIcon(id) ?? '')}">${esc(agents[id].name)}${p === 'desktop' ? ' app' : ''}</a>`).join('');
}

$('q').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!snap) return;
  render({ model: $('model').value.trim(), inputTokens: Number($('in').value), outputTokens: Number($('out').value) });
});

renderAgents();
$('status').textContent = 'Loading prices…';
fetch('data/snapshot.json', { cache: 'no-store' })
  .then((r) => { if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`); return r.json(); })
  .then((s) => { snap = s; renderMeta(); $('q').requestSubmit(); })
  .catch((e) => { $('status').textContent = `Could not load prices: ${e.message}. Try again in a minute.`; });
