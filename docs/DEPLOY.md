# Deploying the read-only ledger page

The page is static files only (`web/dist/`: `index.html`, `style.css`, `app.js`). It calls the public Monad RPC straight from the visitor's browser, so no server, key or database is needed.

It is published with **GitHub Pages**, built by a GitHub Action: free, in the same place as the code, and no extra account. Live at `https://owenzhao9.github.io/flip-garden/`.

How it is set up (done on 2026-10-11 with the owner's approval):

1. `.github/workflows/pages.yml`: on a push to `main` that touches `web/`, `src/` or the workflow itself, run `npm ci --prefix web` and `npm run build --prefix web`, upload `web/dist` as the Pages artifact and deploy it.
2. Repository settings: Pages source is "GitHub Actions".
3. The first run succeeded for commit `05a7cf1`; opening the site and pressing "Try the example wallet" reproduced the numbers in the README (difference 0 on all 6 checks).

Not tested yet: the layout on a real phone, and how the page behaves when the public RPC rate-limits a busy period (the page is written to explain it in plain words).

Alternative hosts, if the page ever needs a server-side secret (for example an indexer API key): Cloudflare Pages or Vercel, with build command `npm run build --prefix web` and output folder `web/dist`.

Local preview: `cd web && npm install && npm run build && python3 -m http.server 8788 --bind 127.0.0.1 --directory dist`.
