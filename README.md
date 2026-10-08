# DevriX QA Audit

A local web app that audits a WordPress site by crawling it and produces the DevriX house-template QA report: verdict, severity bar, filter chips, issue cards with screenshots, "What passed" and "How this was checked". It also writes Asana-ready tickets and a JSON file. It applies fixed rules, so no AI calls are needed.

## Setup

Requires Node 18.17 or newer.

```bash
npm install          # installs Playwright and downloads Chromium
npm start            # → http://127.0.0.1:4317
```

Enter a site URL, add the brand rules (fonts, hex colours, approved phone numbers), and click **Run audit**. A 250-page site takes about 5–10 minutes. Reports are stored in `data/audits/<id>/`. Save the rules as a **profile** so the next run for the same client is one click. An A&J Property Restoration profile is included.

### CLI / CI

```bash
node cli.js https://example.com --out ./qa-reports
node cli.js --profile "A&J Property Restoration"
node cli.js https://staging.example.com --config profile.json
```

The CLI exits with code `1` when it finds P0 or P1 issues, so it can gate a deploy.

### Settings

| Env var | Default | |
|---|---|---|
| `PORT` | 4317 | Web UI port |
| `HOST` | 127.0.0.1 | Use `0.0.0.0` to share the app on your network |
| `QA_DATA_DIR` | `./data` | Where profiles and reports are stored (local disk) |
| `PUBLIC_URL` | request host | Base for share links, e.g. `https://qa.devrix.com` |
| `BLOB_READ_WRITE_TOKEN` | — | Set by Vercel when you connect a Blob store; switches storage to Vercel Blob |
| `QA_BLOB_ACCESS` | `private` | `private` or `public`, matching your Blob store type |
| `QA_BLOB_PREFIX` | `qa-audit` | Folder inside the Blob store |
| `QA_STEP_SECONDS` | 240 on Vercel, off locally | Split audits into time-boxed steps that resume from a checkpoint |
| `QA_SELF_URL` | `VERCEL_URL` | URL the app calls to start its next step |

## Sharing reports

> **No login:** the app has no built-in login. Anyone who can reach its URL can run audits, see every report and create share links. On Vercel, restrict the app's URL with **Settings → Deployment Protection** if needed. Share links live on the same domain, so if you protect the whole deployment, recipients will need access too (or a Vercel protection bypass).

Click **Share** next to a finished audit to create a link like `https://your-app/s/At5AajAq5t4FOC9a_A0fNp2A`. Anyone with the link can open the report.

- **Expiry:** 7, 30 or 90 days, or never. Expired links show a "Link expired" page (HTTP 410).
- **Turn off:** revokes a link immediately. Deleting an audit removes all of its links.
- **Include Asana tickets and JSON:** adds `…/s/<token>/tickets.md` and `…/s/<token>/results.json` downloads.
- **Views:** each link counts its views and shows when it was last opened.
- Tokens are 144-bit random values. Shared pages send `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`, so they aren't indexed and the link doesn't leak to other sites.

Others can only open a link if they can reach the app. That works in these setups:

| Where the app runs | Storage | Notes |
|---|---|---|
| **Vercel** (recommended) | Vercel Blob | In the project: **Storage → Create → Blob** (private) and connect it. That adds `BLOB_READ_WRITE_TOKEN`. Then redeploy |
| A server or VM | Local disk (`data/`) | `HOST=0.0.0.0 PUBLIC_URL=https://qa.example.com npm start` behind HTTPS (Caddy or nginx) |
| Your laptop, temporarily | Local disk | `cloudflared tunnel --url http://localhost:4317`. Links stop working when the laptop or tunnel is off |

Storage is chosen automatically. With `BLOB_READ_WRITE_TOKEN` set, profiles, audits, reports, logs and share links all go to Blob under `qa-audit/`. Otherwise they go to `data/`. The app header shows which one is active. On Vercel without Blob, it shows a warning, because `/tmp` is wiped between instances.

## Deploy on Vercel

The same web UI and API run on [Vercel](https://vercel.com) as a single Node.js function (`api/server.js`). Static assets and routes are rewritten to that handler via `vercel.json`.

**Create the project**

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In the Vercel dashboard: **Add New → Project**, import the repo, leave the default settings (Vercel reads `vercel.json`).
3. **Storage → Create → Blob** (private) and connect it to the project, so reports and share links persist.
4. Deploy.

Or with the [Vercel CLI](https://vercel.com/docs/cli):

```bash
npm i -g vercel
vercel          # link and deploy preview
vercel --prod   # production
```

**Long audits on Vercel**

A Vercel function stops after 300 s, but a full audit of a 250-page site takes longer, so the app runs it in steps. Each step saves its progress to Blob and starts the next step itself. If a hand-off fails (for example during a redeploy), the audit shows **Stalled** with a **Resume** button, which continues from the last checkpoint.

- Steps call the deployment's own URL (`VERCEL_URL`). If **Deployment Protection** is on, enable **Protection Bypass for Automation**. Vercel then sets `VERCEL_AUTOMATION_BYPASS_SECRET`, and the app sends it automatically. Or set `QA_SELF_URL` to a URL that isn't protected.
- Checkpoints need durable storage, so connect Vercel Blob. Without it, steps on different instances can't see each other's progress.

**How it differs from local**

| | Local (`npm start`) | Vercel |
|---|---|---|
| Chromium | Playwright download (`postinstall`) | `@sparticuz/chromium` (Chromium 141, matches Playwright 1.56). Its `--single-process` flag is removed in `src/browser.js`, because with Playwright it closes the whole browser when a page closes |
| Reports, profiles, share links | `data/` (persistent) | Vercel Blob when connected; otherwise `/tmp` (ephemeral, with a warning in the UI) |
| Live progress | In memory | Saved to storage every ~3 s, so any instance can show it |
| Running an audit | One process, start to finish | **Steps.** Each function run works for up to `QA_STEP_SECONDS` (240 s), saves a checkpoint (`audits/<id>/state.json`) and calls `/api/audits/<id>/continue` to start the next step. A 250-page site takes about 4–8 steps |
| Max audit time | Unlimited | No overall limit. Each step stays under the 300 s `maxDuration` |
| Memory | Default Node | **2048 MB** (`vercel.json`). Pages render one at a time on Vercel to stay within it |


## What it checks

The pipeline runs in this order: **discover → crawl → links → render → speed → report**.

| Stage | How | Checks |
|---|---|---|
| Discover | robots.txt → sitemap index → sitemaps. Falls back to a link crawl if there's no sitemap | Sitemap present; robots.txt blocking the site |
| Crawl (every URL) | HTTP fetch, server HTML parsed in Chromium (no scripts run) | Status and redirects, titles (missing, duplicate, long, brand repeated), descriptions, canonicals, noindex, og:image, JSON-LD validity, H1 count, heading skips, alt text, empty links and buttons, unlabeled fields, duplicate IDs, inline CSS/JS size, mixed content, placeholder/lorem ipsum, near-empty pages, phone links (text vs `tel:` mismatch, empty, numbers outside the approved list), media from other multisite sites |
| Links | Every internal link target not already crawled | 404/5xx with source pages, redirect chains and 302s, configured legacy redirects. Optional: external links |
| Render (sample) | Chromium at 1280px and 375px; all non-post templates plus a spread of posts | Computed fonts vs brand (and whether off-brand fonts actually load, so a fallback is flagged as the root cause), headings set in the body font, off-palette colours, WCAG contrast (text over images is skipped), horizontal overflow, touch targets, broken and upscaled images, mouse-only controls (FAQ/accordion divs), invisible or weak focus states, phone links after call-tracking scripts run, console errors, failed requests |
| Mobile menu | Taps the detected toggle | Opens, sets `aria-expanded`, closes with Escape |
| Speed | Cold-cache runs per key template (median) | TTFB, DCL, load, LCP (and lazy-loaded LCP image), CLS, own CSS/JS over budget, third-party weight |
| Headers | Homepage response | HSTS, nosniff, CSP, Referrer-Policy, Permissions-Policy, frame protection, version leaks |

Issues are grouped by root cause, not one per element. Each issue is placed in a report section: **Site-wide** when it spans several templates, otherwise its template group (for example *Services (11)*) or the single page. Severity follows the QA skill: P0 blocks launch; P1 is wrong contact details, broken mobile layout or headline fonts falling back; P2 covers accessibility blockers, broken links and performance; P3 is polish. The verdict is CRITICAL BLOCKER (any P0), NOT READY (5+ P1), READY WITH RISKS (any P1 or P2) or READY.

## Outputs per audit

- `report.html`: standalone house-template report with screenshots embedded, with the issue highlighted in pink
- `artifact.html`: the same report without a page wrapper, ready to publish as a claude.ai artifact
- `asana-tickets.md`: one ticket per P0–P3 issue in the DevriX ticket format
- `qa-results.json`: machine-readable results with IDs that match the report

## What it doesn't do (by design)

- **Layout vs Figma.** Without AI, the app can't interpret a Figma frame. It enforces the brand rules you enter (fonts, palette, phones). Page-level layout fidelity is reported as UNVERIFIABLE.
- **Active security testing and form submission.** All checks are passive. That's safe on production.
- **Field Core Web Vitals.** Speed numbers are lab measurements from the machine running the audit.

## Tests

```bash
npm test             # audit fixture (23 planted defects) + sharing/storage tests + step-mode test
```

`test/run-steps.js` forces 8-second steps (`QA_STEP_SECONDS=8`), so one audit is split across several checkpointed steps the way it is on Vercel. It checks that the result matches a single run. Add `QA_USE_SPARTICUZ=1` to use the Vercel Chromium build, which needs Linux x64.

`test/run-sharing.js` runs the same storage tests against local disk and an in-memory Vercel Blob stand-in. It then checks the share flow end to end: create, open without login, expiry, revoke, file downloads, and deleting an audit.

This starts a small WordPress-like fixture site (`test/fixture/server.js`) with 23 planted defects. It runs a full audit and checks that each defect is reported. The report is written to `test/output/`.

## Project layout

```
server.js                 web UI + job queue + report storage
cli.js                    command-line runner
public/                   UI (index.html, app.js, app.css)
src/config.js             input validation and defaults
src/discover.js           robots, sitemaps, link-crawl fallback
src/http.js               fetch with visible redirect chains, bounded concurrency
src/extract.js            server-HTML extraction (runs in Chromium via DOMParser)
src/static-audit.js       crawl, link and legacy-redirect checks
src/render-checks.js      in-page rendered checks (fonts, colours, contrast, focus…)
src/render-audit.js       rendering runner and mobile menu test
src/perf.js               performance runs
src/rules.js              rules engine: raw data → grouped, ranked issues and passes
src/report.js             house-template HTML, Asana markdown, JSON
src/template-*.{html,js}  report CSS and script, copied verbatim from the QA skill template
src/default-profiles.json starter profile (A&J Property Restoration)
src/storage.js            local disk / Vercel Blob storage drivers
src/shares.js             share links: create, expire, revoke, view counts
```
