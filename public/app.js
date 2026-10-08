'use strict';
const $ = (s) => document.querySelector(s);
const form = $('#f');
const STAGES = [['discover', 'Discover'], ['static', 'Crawl'], ['links', 'Links'], ['render', 'Render'], ['perf', 'Speed'], ['report', 'Report']];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let profiles = {};
let watching = null;

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function readForm() {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    const parts = el.name.split('.');
    let t = o;
    parts.slice(0, -1).forEach((p) => { t = t[p] = t[p] || {}; });
    t[parts[parts.length - 1]] = v;
  }
  return o;
}
function fillForm(cfg) {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.name.split('.').reduce((a, k) => (a == null ? a : a[k]), cfg);
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = Array.isArray(v) ? v.join(el.tagName === 'TEXTAREA' ? '\n' : ', ') : v;
  }
  swatches();
}

function swatches() {
  const raw = $('#colors').value.split(/[\s,]+/).filter(Boolean);
  $('#swatches').innerHTML = raw.map((c) => {
    const h = c.replace(/^#/, '');
    const ok = /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h);
    return `<span class="sw${ok ? '' : ' bad'}" title="${ok ? '' : 'Not a hex colour'}"><i style="background:${ok ? '#' + esc(h) : 'transparent'}"></i>${esc(ok ? '#' + h.toUpperCase() : c)}</span>`;
  }).join('');
}
$('#colors').addEventListener('input', swatches);

async function loadProfiles(select) {
  profiles = await api('/api/profiles');
  const sel = $('#profile');
  sel.innerHTML = '<option value="">Load a saved profile…</option>' + Object.keys(profiles).sort().map((n) => `<option>${esc(n)}</option>`).join('');
  if (select) sel.value = select;
  $('#delProfile').hidden = !sel.value;
}
$('#profile').addEventListener('change', (e) => {
  const p = profiles[e.target.value];
  $('#delProfile').hidden = !e.target.value;
  if (p) { form.reset(); fillForm(p); }
});
$('#saveProfile').addEventListener('click', async () => {
  const cur = $('#profile').value || $('#siteName').value || (() => { try { return new URL($('#url').value).host; } catch { return ''; } })();
  const name = cur.trim();
  if (!name) return showErr('Enter a site URL or report name first, so the profile has a name.');
  try { await api('/api/profiles', { method: 'POST', body: { name, config: readForm() } }); await loadProfiles(name); flash($('#saveProfile'), 'Saved'); } catch (e) { showErr(e.message); }
});
$('#delProfile').addEventListener('click', async () => {
  const n = $('#profile').value; if (!n) return;
  const b = $('#delProfile');
  if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Click again to delete'; setTimeout(() => { b.dataset.confirm = ''; b.textContent = 'Delete'; }, 3000); return; }
  await api('/api/profiles/' + encodeURIComponent(n), { method: 'DELETE' }); b.dataset.confirm = ''; b.textContent = 'Delete'; await loadProfiles('');
});
function flash(btn, text) { const t = btn.textContent; btn.textContent = text; setTimeout(() => { btn.textContent = t; }, 1500); }
function showErr(m) { const e = $('#formErr'); e.textContent = m; e.hidden = !m; }

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showErr('');
  if (!$('#url').value.trim()) { showErr('Enter the site URL to audit.'); $('#url').focus(); return; }
  $('#go').disabled = true;
  try { const { id } = await api('/api/audits', { method: 'POST', body: readForm() }); watching = id; await refresh(); }
  catch (err) { showErr(err.message); }
  finally { $('#go').disabled = false; }
});

function verdictPill(a) {
  if (a.status === 'running' || a.status === 'queued') return `<span class="verdict v-run">${a.status === 'queued' ? 'QUEUED' : 'RUNNING'}</span>`;
  if (a.status === 'error') return '<span class="verdict v-error">FAILED</span>';
  const v = (a.summary && a.summary.verdict) || '';
  const cls = /WITH RISKS/.test(v) ? 'v-RISKS' : 'v-' + v.split(' ')[0];
  return `<span class="verdict ${cls}">${esc(v)}</span>`;
}
function counts(a) {
  const c = (a.summary && a.summary.counts) || {};
  return `<span class="pills">${['P0', 'P1', 'P2', 'P3', 'INFO'].map((k) => `<span class="mini b-${k}" title="${k}">${c[k] ?? 0}</span>`).join('')}</span>`;
}
function when(t) { return t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; }

function renderLive(a) {
  const live = $('#live');
  if (!a || !(a.status === 'running' || a.status === 'queued')) { live.hidden = true; return; }
  live.hidden = false;
  const idx = STAGES.findIndex(([k]) => k === a.stage);
  const pct = a.progress && a.progress.total ? Math.round((a.progress.done / a.progress.total) * 100) : 0;
  live.innerHTML = `<div class="live-h"><span>${esc(a.siteName || a.site)}</span><span class="muted">${a.status === 'queued' ? 'Waiting in queue' : esc((STAGES[idx] || ['', 'Starting'])[1]) + (a.progress && a.progress.total > 1 ? ` · ${a.progress.done}/${a.progress.total}` : '')}</span></div>
  <div class="stages" role="progressbar" aria-valuemin="0" aria-valuemax="6" aria-valuenow="${Math.max(idx, 0)}" aria-label="Audit progress">${STAGES.map(([k, l], i) => `<div class="st ${i < idx ? 'done' : i === idx ? 'on' : ''}"><b><span style="width:${i < idx ? 100 : i === idx ? pct : 0}%"></span></b>${l}</div>`).join('')}</div>
  <pre class="log" tabindex="0" aria-label="Audit log">${esc((a.log || []).slice(-14).join('\n'))}</pre>`;
  const lg = live.querySelector('.log'); lg.scrollTop = lg.scrollHeight;
}

async function refresh() {
  const list = await api('/api/audits').catch(() => []);
  const active = list.find((a) => a.status === 'running') || list.find((a) => a.status === 'queued');
  if (active) { const d = await api('/api/audits/' + active.id).catch(() => null); renderLive(d); } else renderLive(null);
  $('#count').textContent = list.length ? `${list.length} saved` : '';
  $('#empty').hidden = list.length > 0;
  $('#history').innerHTML = list.map((a) => {
    const done = a.status === 'done';
    const base = `/reports/${a.id}/`;
    return `<li class="h-item"><div><div class="h-site">${esc(a.siteName || a.site)}</div><div class="h-meta">${esc(a.site)} · ${esc(a.environment)} · ${when(a.createdAt)}${a.summary ? ` · ${a.summary.pages} URLs · ${Math.round(a.summary.durationMs / 60000) || '<1'} min` : ''}${a.error ? ` · ${esc(a.error)}` : ''}</div></div>
      <div style="display:grid;gap:6px;justify-items:end">${verdictPill(a)}${done ? counts(a) : ''}</div>
      <div class="h-links">${done ? `<a href="${base}report.html" target="_blank" rel="noopener">Open report</a><a href="${base}report.html?download">Download HTML</a><a href="${base}asana-tickets.md?download">Asana tickets (.md)</a><a href="${base}qa-results.json?download">Results (.json)</a><a href="${base}artifact.html" target="_blank" rel="noopener" title="The report without page wrapper, ready to publish as a claude.ai artifact">Artifact source</a>` : ''}
      <button type="button" class="ghost" data-rerun="${a.id}">Run again</button>${a.status !== 'running' ? `<button type="button" class="ghost danger" data-del="${a.id}">Delete</button>` : ''}</div></li>`;
  }).join('');
  clearTimeout(refresh.t);
  refresh.t = setTimeout(refresh, active ? 1500 : 8000);
}
$('#history').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const rr = e.target.closest('[data-rerun]');
  if (del) {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Click again to delete'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = 'Delete'; }, 3000); return; }
    await api('/api/audits/' + del.dataset.del, { method: 'DELETE' }).catch((err) => alertInline(err.message)); refresh();
  }
  if (rr) {
    const a = await api('/api/audits/' + rr.dataset.rerun);
    if (a.input) { form.reset(); fillForm(a.input); window.scrollTo({ top: 0, behavior: 'smooth' }); $('#url').focus(); }
  }
});
function alertInline(m) { showErr(m); }

loadProfiles('').then(refresh);
