'use strict';
// A small WordPress-like site with planted defects, used to verify the audit end to end.
const http = require('http');
const fs = require('fs');

const FONTS = {
  '/fonts/heading.ttf': '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
  '/fonts/body.ttf': '/usr/share/fonts/truetype/google-fonts/Poppins-Regular.ttf',
};
const BIG_CSS = '.u{color:#123}\n'.repeat(11000); // ~170 KB inline CSS (planted: inline budget)

function layout(o, path) {
  return `<!doctype html><html lang="en-US"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>${o.desc ? `<meta name="description" content="${o.desc}">` : ''}
<link rel="canonical" href="http://localhost:${PORT}${path}">
${o.og === false ? '' : `<meta property="og:image" content="http://localhost:${PORT}/img/hero.svg">`}
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Fixture Co"},{"@type":"WebPage"}]}</script>
${o.badLd ? '<script type="application/ld+json">{"@type": "FAQPage",, }</script>' : ''}
<link rel="stylesheet" href="/wp-content/themes/fixture/style.css">
<style id="theme_style-inline-css">${o.bigCss ? BIG_CSS : ''}
@font-face{font-family:"Fixture Serif";src:url(/fonts/heading.ttf);font-weight:700}
@font-face{font-family:"Poppins";src:url(/fonts/body.ttf);font-weight:400}
body{margin:0;font-family:Poppins,sans-serif;color:#222222;background:#fff}
h1,h2,h3{font-family:"Fixture Serif",serif;color:#A6263F}
.has-barlow-condensed-font-family{font-family:"Barlow Condensed",sans-serif}
.has-archivo-font-family{font-family:Archivo,Arial,sans-serif}
.btn{display:inline-block;background:#FFC800;color:#0D0D0D;padding:12px 18px;text-decoration:none}
.btn:focus{outline:2px solid #0D0D0D}
.low{color:#BBBBBB}
.faq-question{cursor:pointer;padding:8px;border:1px solid #ddd}
.drawer{display:none}.drawer.open{display:block}
.toggle{width:40px;height:40px}
@media(min-width:800px){.toggle{display:none}.drawer{display:block}}
.wide{width:620px;background:#EFEFEF}
footer{background:#0D0D0D;color:#C9C8C8;padding:20px}
a{color:#A6263F}
</style></head>
<body class="page wp-theme-fixture wp-embed-responsive">
<a class="skip-link screen-reader-text" href="#main" style="position:absolute;left:-9999px">Skip to content</a>
<header><button class="toggle" id="menu-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="Toggle menu">☰</button>
<nav id="site-nav" class="drawer"><a href="/">Home</a> <a href="/services/">Services</a> <a href="/about/">About</a> <a href="/contact/">Contact</a> <a href="/blog/">Blog</a></nav>
<a class="btn" href="tel:8005550100">Call 800-555-0100</a></header>
<main id="main" class="wp-block-group">${o.body}</main>
<footer><p>Fixture Co. All rights reserved. <a href="mailto:info@example.com" style="color:#C9C8C8">info@example.com</a></p></footer>
<script>document.getElementById('menu-toggle').addEventListener('click',function(){var n=document.getElementById('site-nav');var o=n.classList.toggle('open');this.setAttribute('aria-expanded',o)});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){document.getElementById('site-nav').classList.remove('open');document.getElementById('menu-toggle').setAttribute('aria-expanded','false')}});
document.querySelectorAll('.faq-question').forEach(function(q){q.addEventListener('click',function(){q.nextElementSibling.hidden=!q.nextElementSibling.hidden})});</script>
</body></html>`;
}

const LOREM = 'We restore homes and businesses after fire, water and storm damage. Our crews respond around the clock and handle the insurance paperwork so you can focus on your family. ';
const posts = Array.from({ length: 30 }, (_, i) => `/blog/post-${i + 1}/`);

const ROUTES = {
  '/': () => ({ title: 'Fixture Co | Restoration Services', desc: 'Restoration services home.', bigCss: true, body: `<h1>24/7 Restoration</h1><p>${LOREM.repeat(3)}</p>
    <div class="faq-question"><h3>How fast can you respond?</h3></div><div hidden><p>Within an hour.</p></div>
    <div class="faq-question"><h3>Do you work with insurance?</h3></div><div><p>Yes.</p></div>
    <h3>Locations</h3><p>Madison <a href="tel:608-555-0199">608-555-0199</a> · Milwaukee <a href="tel:404-620-6848">404-620-6848</a></p>
    <p class="low">Light grey disclaimer text that fails contrast.</p><p><a href="/services/">See services</a> <a href="/blog/category/news/">News</a></p>` }),
  '/services/': () => ({ title: 'Services | Fixture Co', desc: 'All services.', body: `<h1>Services</h1><p>${LOREM.repeat(2)}</p><ul><li><a href="/services/mold/">Mold</a></li><li><a href="/services/fire/">Fire</a></li></ul>` }),
  '/services/mold/': () => ({ title: 'Mold Remediation | Fixture Co', desc: 'Mold.', body: `<h1 class="has-barlow-condensed-font-family">Mold Remediation Services</h1><p class="has-archivo-font-family">${LOREM.repeat(2)}</p><p><a class="btn" href="tel:6784661800">Call 800-555-0100</a></p>` }),
  '/services/fire/': () => ({ title: 'Fire Damage | Fixture Co', desc: 'Fire.', body: `<h1 class="has-barlow-condensed-font-family">Fire Damage Restoration</h1><p>${LOREM.repeat(2)}<a href="tel:3855335183"></a></p>` }),
  '/about/': () => ({ title: 'About | Fixture Co', desc: 'About us.', body: `<h1>About us</h1><p>${LOREM.repeat(2)}</p><img src="/img/team.svg" width="300" height="200"><div class="wide">This box is wider than a phone screen.</div>` }),
  '/contact/': () => ({ title: 'Contact | Fixture Co', desc: 'Contact.', og: false, body: `<h1>Contact</h1><p>${LOREM}</p><form><input type="text" name="your-name" placeholder="Name"><label for="em">Email</label><input id="em" type="email"><button type="submit">Send</button></form><p>Milwaukee office: 414-555-0177</p>` }),
  '/blog/': () => ({ title: 'Blog | Fixture Co', body: `<h1>Blog</h1><p>${LOREM}</p>${posts.map((p) => `<a href="${p}">${p}</a>`).join(' ')}` }),
  '/blog/category/news/': () => ({ title: 'News | Fixture Co', body: `<h1>News</h1><p>${LOREM}</p><a href="${posts[0]}">First</a>` }),
};
posts.forEach((p, i) => { ROUTES[p] = () => ({ title: `Post ${i + 1} title | Fixture Co Tips | Fixture Co`, desc: `Post ${i + 1}.`, badLd: i === 3, body: `<h1>Post ${i + 1}</h1><article><h1>Post ${i + 1} again</h1><p>${LOREM.repeat(2)}</p>${i % 3 === 0 ? '<p><a href="/services/old/fire-damage/">old fire page</a></p>' : ''}</article>` }); });

const PORT = +process.env.FIXTURE_PORT || 4599;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (FONTS[p]) { res.writeHead(200, { 'content-type': 'font/ttf' }); return fs.createReadStream(FONTS[p]).pipe(res); }
  if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nDisallow: /wp-admin/\nSitemap: http://localhost:${PORT}/sitemap_index.xml\n`); }
  if (p === '/sitemap_index.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>http://localhost:${PORT}/page-sitemap.xml</loc></sitemap><sitemap><loc>http://localhost:${PORT}/post-sitemap.xml</loc></sitemap></sitemapindex>`); }
  if (p === '/page-sitemap.xml' || p === '/post-sitemap.xml') {
    const list = p.startsWith('/page') ? ['/', '/services/', '/services/mold/', '/services/fire/', '/about/', '/contact/', '/blog/', '/blog/category/news/', '/gone/'] : posts;
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${list.map((x) => `<url><loc>http://localhost:${PORT}${x}</loc></url>`).join('')}</urlset>`);
  }
  if (p === '/old-services/') { res.writeHead(301, { location: '/services/' }); return res.end(); }
  if (p.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#EFEFEF"/></svg>'); }
  if (p === '/wp-content/themes/fixture/style.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('/* theme */'); }
  const r = ROUTES[p];
  if (!r) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Not found</title><h1>Not found</h1>'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8', 'x-content-type-options': 'nosniff', 'x-powered-by': 'PHP/7.4.33' });
  res.end(layout(r(), p));
});
server.listen(PORT, () => console.log('fixture on http://localhost:' + PORT));
module.exports = server;
