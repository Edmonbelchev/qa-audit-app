'use strict';
// "Load from WordPress" against a mock WordPress REST API (theme endpoint mode and core theme.json mode).
const http = require('http');
const { loadProfile } = require('../src/wp-profile');

let fail = 0;
const check = (ok, name) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail++; };
const AUTH = 'Basic ' + Buffer.from('editor:abcdefghijklmnopqrstuvwx').toString('base64');

function mockWp(withTheme) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const authed = req.headers.authorization === AUTH;
    const port = req.socket.localPort;
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<a href="tel:800-727-8990">Call</a><a href="tel:8007278990">x</a><a href="tel:404-620-6848">Milwaukee</a>'); }
    if (u.pathname === '/wp-json/') return json(200, { name: 'A&J Property Restoration', home: `http://127.0.0.1:${port}`, namespaces: ['wp/v2', ...(withTheme ? ['devrix-qa/v1'] : [])] });
    if (!authed) return json(401, { code: 'rest_not_logged_in' });
    if (u.pathname === '/wp-json/wp/v2/users/me') return json(200, { name: 'Edmon', slug: 'editor' });
    if (u.pathname === '/wp-json/devrix-qa/v1/profile') return json(200, { source: 'american-restoration theme (Theme Global Settings)', site: { name: 'A&J Property Restoration' }, colors: [{ slug: 'primary', name: 'Primary', color: '#a6263f' }, { slug: 'accent', name: 'Accent', color: '#FFC800' }], palette: [{ slug: 'white', name: 'White', color: '#ffffff' }, { slug: 'primary', name: 'Primary', color: '#A6263F' }], fonts: { headings: { slug: 'bitter', family: 'Bitter' }, body: { slug: 'poppins', family: 'Poppins' } }, phones: [{ digits: '8007278990', label: 'Call 800-727-8990', where: ['Header CTA'] }] });
    if (u.pathname === '/wp-json/wp/v2/themes') return json(200, [{ stylesheet: 'american-restoration', _links: { 'wp:user-global-styles': [{ href: `http://127.0.0.1:${port}/wp-json/wp/v2/global-styles/42` }] } }]);
    if (u.pathname === '/wp-json/wp/v2/global-styles/themes/american-restoration') return json(200, { settings: { color: { palette: { theme: [{ slug: 'primary', name: 'Primary', color: '#A6263F' }, { slug: 'dark', name: 'Dark', color: 'rgb(13, 13, 13)' }] } }, typography: { fontFamilies: { theme: [{ slug: 'bitter', fontFamily: '"Bitter", serif' }, { slug: 'poppins', fontFamily: 'Poppins, sans-serif' }] } } }, styles: { typography: { fontFamily: 'var:preset|font-family|poppins' } } });
    if (u.pathname === '/wp-json/wp/v2/global-styles/42') return json(200, { styles: { elements: { heading: { typography: { fontFamily: 'var(--wp--preset--font-family--bitter)' } } } } });
    json(404, {});
  });
}

const listen = (s) => new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s.address().port)));

(async () => {
  for (const withTheme of [true, false]) {
    const s = mockWp(withTheme);
    const port = await listen(s);
    const mode = withTheme ? 'theme endpoint' : 'core theme.json';
    const p = await loadProfile({ siteUrl: `http://127.0.0.1:${port}`, username: 'editor', appPassword: 'abcd efgh ijkl mnop qrst uvwx' });
    check(p.form.brand.headingFonts === 'Bitter' && p.form.brand.bodyFonts === 'Poppins', `${mode}: heading Bitter, body Poppins`);
    check(p.form.brand.colors.includes('#A6263F') && !/#a6/.test(p.form.brand.colors), `${mode}: colours normalised (${p.form.brand.colors})`);
    if (withTheme) {
      check(p.form.phones.expected === '800-727-8990', `${mode}: configured phone → approved list`);
      check(p.suggestedPhones.some((x) => x.digits === '4046206848') && !p.suggestedPhones.some((x) => x.digits === '8007278990'), `${mode}: other homepage numbers offered as suggestions`);
    } else {
      check(p.form.brand.colors.includes('#0D0D0D'), `${mode}: rgb() palette converted`);
      check(p.suggestedPhones.length === 2 && p.phones.length === 0, `${mode}: phones from homepage as suggestions`);
    }
    let bad = null; try { await loadProfile({ siteUrl: `http://127.0.0.1:${port}`, username: 'editor', appPassword: 'wrong' }); } catch (e) { bad = e; }
    check(bad && bad.code === 401, `${mode}: wrong password → clear 401 error`);
    s.close();
  }
  let unreachable = null; try { await loadProfile({ siteUrl: 'http://127.0.0.1:9', username: 'a', appPassword: 'b' }); } catch (e) { unreachable = e; }
  check(unreachable && /REST API/.test(unreachable.message), 'unreachable site → explains the REST API could not be reached');
  console.log(fail ? `\n${fail} failed` : '\nAll WordPress import tests passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
