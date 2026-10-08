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
  if (a.stalled) return '<span class="verdict v-run" title="A step stopped unexpectedly. The audit restarts automatically from its last checkpoint.">RESUMING</span>';
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

let openShare = null; // audit id whose share panel is open (pauses history re-render)

async function refresh() {
  const list = await api('/api/audits').catch(() => []);
  const active = list.find((a) => a.status === 'running') || list.find((a) => a.status === 'queued');
  if (active) { const d = await api('/api/audits/' + active.id).catch(() => null); renderLive(d); } else renderLive(null);
  $('#count').textContent = list.length ? `${list.length} saved` : '';
  $('#empty').hidden = list.length > 0;
  if (!openShare) $('#history').innerHTML = list.map((a) => {
    const done = a.status === 'done';
    const base = `/reports/${a.id}/`;
    return `<li class="h-item" data-id="${a.id}"><div><div class="h-site">${esc(a.siteName || a.site)}</div><div class="h-meta">${esc(a.site)} · ${esc(a.environment)} · ${when(a.createdAt)}${a.summary ? ` · ${a.summary.pages} URLs · ${Math.round(a.summary.durationMs / 60000) || '<1'} min` : ''}${a.error ? ` · ${esc(a.error)}` : ''}</div></div>
      <div style="display:grid;gap:6px;justify-items:end">${verdictPill(a)}${done ? counts(a) : ''}</div>
      <div class="h-links">${done ? `<button type="button" class="share-btn" data-share="${a.id}" aria-expanded="false">Share${a.shareCount ? ` · ${a.shareCount}` : ''}</button><a href="${base}report.html" target="_blank" rel="noopener">Open report</a><a href="${base}report.html?download">Download HTML</a><a href="${base}asana-tickets.md?download">Asana tickets (.md)</a><a href="${base}qa-results.json?download">Results (.json)</a><a href="${base}artifact.html" target="_blank" rel="noopener" title="The report without page wrapper, ready to publish as a claude.ai artifact">Artifact source</a>` : ''}
      <button type="button" class="ghost" data-rerun="${a.id}">Run again</button>${a.status !== 'running' || a.stalled ? `<button type="button" class="ghost danger" data-del="${a.id}">Delete</button>` : ''}</div>
      <div class="share" id="share-${a.id}" hidden></div></li>`;
  }).join('');
  clearTimeout(refresh.t);
  refresh.t = setTimeout(refresh, active ? 1500 : 8000);
}

// ───── Share links
const EXPIRY = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['0', 'Never']];
function fmtDate(t) { return t ? new Date(t).toLocaleDateString([], { dateStyle: 'medium' }) : ''; }
function shareRow(s) {
  const st = { active: s.expiresAt ? `Expires ${fmtDate(s.expiresAt)}` : 'No expiry', expired: `Expired ${fmtDate(s.expiresAt)}`, revoked: 'Turned off' }[s.state];
  const views = `${s.views || 0} view${s.views === 1 ? '' : 's'}${s.lastViewedAt ? `, last ${fmtDate(s.lastViewedAt)}` : ''}`;
  return `<li class="sl ${s.state}"><div class="sl-url"><input type="text" readonly value="${esc(s.url)}" aria-label="Share link" id="sl-${esc(s.token)}"><button type="button" data-copy="${esc(s.token)}" ${s.state !== 'active' ? 'disabled' : ''}>Copy</button></div>
    <div class="sl-meta"><span class="state-${s.state}">${st}</span> · ${views}${s.includeFiles ? ' · tickets + JSON included' : ''}${s.label ? ` · ${esc(s.label)}` : ''}${s.state === 'active' ? ` <button type="button" class="ghost danger" data-revoke="${esc(s.token)}">Turn off</button>` : ''}</div></li>`;
}
async function openSharePanel(id) {
  const box = $('#share-' + id);
  const btn = document.querySelector(`[data-share="${id}"]`);
  if (openShare && openShare !== id) closeSharePanel();
  if (openShare === id) return closeSharePanel();
  openShare = id;
  btn && btn.setAttribute('aria-expanded', 'true');
  box.hidden = false;
  box.innerHTML = '<p class="muted">Loading links…</p>';
  const list = await api(`/api/audits/${id}/shares`).catch((e) => { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return null; });
  if (!list) return;
  box.innerHTML = `<div class="share-new"><label for="exp-${id}">Link expires</label><select id="exp-${id}">${EXPIRY.map(([v, l]) => `<option value="${v}"${v === '30' ? ' selected' : ''}>${l}</option>`).join('')}</select>
    <input id="lbl-${id}" type="text" placeholder="Label, e.g. Client – Jane" aria-label="Label (optional)" maxlength="80">
    <label class="check"><input type="checkbox" id="inc-${id}"> Include Asana tickets and JSON</label>
    <button type="button" class="primary small" data-create="${id}">Create link</button></div>
    <p class="hint">Anyone with the link can open the report without signing in. Turn a link off at any time.</p>
    <ul class="share-list">${list.length ? list.map(shareRow).join('') : '<li class="muted">No links yet.</li>'}</ul>`;
}
function closeSharePanel() {
  if (!openShare) return;
  const box = $('#share-' + openShare); if (box) { box.hidden = true; box.innerHTML = ''; }
  const btn = document.querySelector(`[data-share="${openShare}"]`); btn && btn.setAttribute('aria-expanded', 'false');
  openShare = null;
  refresh();
}
async function copyText(input, btn) {
  try { await navigator.clipboard.writeText(input.value); flash(btn, 'Copied'); }
  catch { input.focus(); input.select(); flash(btn, 'Press ⌘C'); }
}

$('#history').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const rr = e.target.closest('[data-rerun]');
  const sh = e.target.closest('[data-share]');
  const cr = e.target.closest('[data-create]');
  const cp = e.target.closest('[data-copy]');
  const rv = e.target.closest('[data-revoke]');
  const rs = e.target.closest('[data-resume]');
  if (rs) { rs.disabled = true; await api(`/api/audits/${rs.dataset.resume}/resume`, { method: 'POST' }).catch((err) => showErr(err.message)); return refresh(); }
  if (sh) return openSharePanel(sh.dataset.share);
  if (cr) {
    const id = cr.dataset.create;
    cr.disabled = true;
    try {
      const s = await api(`/api/audits/${id}/shares`, { method: 'POST', body: { days: $('#exp-' + id).value, includeFiles: $('#inc-' + id).checked, label: $('#lbl-' + id).value } });
      openShare = null; await openSharePanel(id);
      const input = document.getElementById('sl-' + s.token);
      if (input) copyText(input, document.querySelector(`[data-copy="${s.token}"]`));
    } catch (err) { showErr(err.message); cr.disabled = false; }
    return;
  }
  if (cp) return copyText(document.getElementById('sl-' + cp.dataset.copy), cp);
  if (rv) {
    if (rv.dataset.confirm !== '1') { rv.dataset.confirm = '1'; rv.textContent = 'Click again to turn off'; setTimeout(() => { rv.dataset.confirm = ''; rv.textContent = 'Turn off'; }, 3000); return; }
    await api('/api/shares/' + rv.dataset.revoke, { method: 'DELETE' }).catch((err) => showErr(err.message));
    const id = openShare; openShare = null; return openSharePanel(id);
  }
  if (del) {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Click again to delete'; setTimeout(() => { del.dataset.confirm = ''; del.textContent = 'Delete'; }, 3000); return; }
    if (openShare === del.dataset.del) openShare = null;
    await api('/api/audits/' + del.dataset.del, { method: 'DELETE' }).catch((err) => showErr(err.message)); refresh();
  }
  if (rr) {
    const a = await api('/api/audits/' + rr.dataset.rerun);
    if (a.input) { form.reset(); fillForm(a.input); window.scrollTo({ top: 0, behavior: 'smooth' }); $('#url').focus(); }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openShare) closeSharePanel(); });

api('/api/info').then((i) => {
  $('#storage').textContent = `Reports stored on ${i.storage}`;
  if (!i.durable) { const w = $('#storeWarn'); w.hidden = false; }
}).catch(() => {});
loadProfiles('').then(refresh);

// ───── Load brand rules from WordPress
(function () {
  const dlg = $('#wp');
  const APP_ID = '6f1d2c3a-8b7e-4a5d-9c1f-2e3d4b5a6c7d';
  let last = null;
  const open = () => { $('#wpSite').value = $('#url').value || $('#wpSite').value; $('#wpErr').hidden = true; try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); } };
  const err = (m) => { const e = $('#wpErr'); e.textContent = m; e.hidden = !m; };
  $('#wpOpen').addEventListener('click', open);
  $('#wpClose').addEventListener('click', () => dlg.close());

  $('#wpAuthorize').addEventListener('click', () => {
    let site;
    try { const u = new URL(/^https?:/i.test($('#wpSite').value) ? $('#wpSite').value : 'https://' + $('#wpSite').value); site = u.origin + u.pathname.replace(/\/+$/, ''); } catch { return err('Enter the WordPress site URL first.'); }
    if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return err('WordPress only sends the approval back to an HTTPS address. Use the application password option instead.');
    try { sessionStorage.setItem('qa-wp-pending', JSON.stringify({ site, form: readForm() })); } catch {}
    const back = location.origin + location.pathname;
    const q = new URLSearchParams({ app_name: 'DevriX QA Audit', app_id: APP_ID, success_url: back + '?wp=ok', reject_url: back + '?wp=rejected' });
    location.href = `${site}/wp-admin/authorize-application.php?${q}`;
  });

  $('#wpLoad').addEventListener('click', () => load($('#wpSite').value, $('#wpUser').value.trim(), $('#wpPass').value));

  async function load(siteUrl, username, appPassword) {
    err('');
    const box = $('#wpResult');
    box.hidden = false; box.innerHTML = '<p class="muted">Reading theme settings…</p>';
    try {
      last = await api('/api/wp/profile', { method: 'POST', body: { siteUrl, username, appPassword } });
      render(last);
    } catch (e) { box.hidden = true; err(e.message); }
    $('#wpPass').value = '';
  }

  function render(p) {
    const sw = (c) => `<span class="sw" title="${esc(c.name || c.slug || '')}"><i style="background:${esc(c.color)}"></i>${esc(c.color)}${c.name ? ' · ' + esc(c.name) : ''}</span>`;
    const colors = [...p.colors, ...p.palette.filter((x) => !p.colors.some((c) => c.color === x.color))];
    const ph = (x, on) => `<button type="button" class="wp-chip" data-ph="${esc(x.label || x.digits)}" aria-pressed="${on}" title="${esc((x.where || []).join(', '))}">${esc(x.label || x.digits)}</button>`;
    $('#wpResult').innerHTML = `<h3>Found on ${esc(p.site.name || p.site.url)}</h3>
      <dl><dt>Source</dt><dd>${esc(p.source)}${p.user ? ` · signed in as ${esc(p.user)}` : ''}</dd>
      <dt>Heading font</dt><dd>${esc((p.fonts.headings || {}).family || '—')}</dd>
      <dt>Body font</dt><dd>${esc((p.fonts.body || {}).family || '—')}</dd>
      <dt>Colours</dt><dd><div class="swatches">${colors.map(sw).join('') || '—'}</div></dd>
      <dt>Phones</dt><dd>${p.phones.map((x) => ph(x, true)).join('') || '—'}${p.suggestedPhones.length ? `<div class="hint">Also on the homepage (click to add):</div>${p.suggestedPhones.map((x) => ph(x, false)).join('')}` : ''}</dd></dl>
      ${p.notes.length ? `<ul class="wp-notes">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="wp-actions"><button type="button" id="wpApply" class="primary small">Apply to form</button></div>`;
  }

  $('#wpResult').addEventListener('click', (e) => {
    const c = e.target.closest('.wp-chip');
    if (c) c.setAttribute('aria-pressed', c.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    if (e.target.id === 'wpApply' && last) {
      const phones = [...$('#wpResult').querySelectorAll('.wp-chip[aria-pressed="true"]')].map((b) => b.dataset.ph);
      const f = JSON.parse(JSON.stringify(last.form));
      f.phones.expected = phones.join('\n');
      if ($('#url').value) delete f.url;
      if ($('#siteName').value) delete f.siteName;
      fillForm(f);
      dlg.close();
      showErr('');
      flash($('#wpOpen'), 'Loaded ✓');
    }
  });

  // Returning from WordPress "Authorize application"
  const q = new URLSearchParams(location.search);
  if (q.get('wp')) {
    let pending = null; try { pending = JSON.parse(sessionStorage.getItem('qa-wp-pending') || 'null'); sessionStorage.removeItem('qa-wp-pending'); } catch {}
    history.replaceState(null, '', location.pathname); // drop the password from the address bar
    if (pending && pending.form) fillForm(pending.form);
    open();
    if (q.get('wp') === 'ok' && q.get('user_login') && q.get('password')) {
      $('#wpSite').value = q.get('site_url') || (pending && pending.site) || '';
      load($('#wpSite').value, q.get('user_login'), q.get('password'));
    } else err('Access was not approved in WordPress.');
  }
})();
