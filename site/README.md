# COOP showcase site

A single static page (`index.html`, `styles.css`, `main.js`, `tokens.css`). There's no build step and it has no dependencies. Equations are native MathML, so no KaTeX/MathJax is needed.

Preview locally:
```bash
python -m http.server 8765 --directory site
```
Then open http://localhost:8765.

## Before publishing: fill the placeholders
Search for `✏️ PLACEHOLDER` (HTML comments) and `data-placeholder` (elements):

| Placeholder | Where | What to put |
|---|---|---|
| `demo-video` | hero | the YouTube embed (the snippet is in the comment next to it) |
| `photo-build`, `photo-hero`, `photo-dashboard`, `photo-mount` | hardware | `<img>` tags. Put files in `site/assets/`, 3:2, ≤500 KB each |
| `devpost-url` | hero + links | the Devpost project URL (until then, `main.js` makes these links inert) |
| `teammate-name` | team | name, initials and a one-line description |
| `coop.example.com` | `<head>` canonical/og | the real hostname |

`tokens.css` is a **copy** of `web/tokens.css`, so that `site/` can be deployed on its own. If the dashboard's tokens change, re-copy the file.

## Hosting it free on your domain

> **Hostname clash:** `scripts/setup_tunnel.md` already uses `coop.<domain>` for the live dashboard (behind Cloudflare Access). One hostname can't serve both. Recommended: put the showcase at `coop.<domain>` (the public link judges get) and move the dashboard to `cam.<domain>`, or keep the dashboard on `coop.` and use the apex or `www.` for this page. Decide before creating either DNS record.

### Option A: Cloudflare Pages (recommended, since the domain's DNS is already on Cloudflare for the tunnel)
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**, then pick this repo.
2. Build settings: framework **None**, build command **empty**, build output directory **`site`**.
3. Deploy. You get `<project>.pages.dev`, and every push to `main` redeploys.
4. **Custom domains → Set up a domain** → `coop.<domain>` (or whichever hostname you chose above). Because the zone is on Cloudflare, it creates the CNAME and certificate automatically.
5. Don't put a Cloudflare Access policy on this hostname. It's the public page.

### Option B: GitHub Pages
GitHub Pages can only publish from the repo root or `/docs`, so deploy `site/` with an Actions workflow:
1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Add `.github/workflows/pages.yml`:
   ```yaml
   name: Deploy site
   on:
     push:
       branches: [main]
       paths: ["site/**"]
     workflow_dispatch:
   permissions: { contents: read, pages: write, id-token: write }
   concurrency: { group: pages, cancel-in-progress: true }
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment: { name: github-pages, url: "${{ steps.d.outputs.page_url }}" }
       steps:
         - uses: actions/checkout@v4
         - uses: actions/upload-pages-artifact@v3
           with: { path: site }
         - id: d
           uses: actions/deploy-pages@v4
   ```
3. **Settings → Pages → Custom domain** → `coop.<domain>`, then tick **Enforce HTTPS** once the certificate is issued.
4. At your DNS provider, add `CNAME coop → <github-user>.github.io`. If the DNS is on Cloudflare, set that record to **DNS only** (grey cloud) until GitHub has issued its certificate.

Either option costs nothing. Cloudflare Pages is less setup here because the DNS and the tunnel already live in the same Cloudflare account.
