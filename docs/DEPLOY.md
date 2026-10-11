# Deploying the read-only ledger page (proposal, not done yet)

The page is static files only (`web/dist/`: `index.html`, `style.css`, `app.js`). It calls the public Monad RPC straight from the visitor's browser, so no server, key or database is needed.

Recommended: **GitHub Pages**, built by a GitHub Action. Free, same place as the code, and the link can go on the hackathon platform.

Steps (each one needs the owner's approval; nothing here has been run):

1. `.github/workflows/pages.yml` (added): on push to `main`, build `web/` and deploy `web/dist` with GitHub Pages.
2. In the repository settings, set Pages source to "GitHub Actions" (a repository setting change).
3. Push the branch with the page to `main`. The site appears at `https://owenzhao9.github.io/flip-garden/`.
4. Open it, press "Try the example wallet", and check the numbers against the README.

Alternative: any static host (Cloudflare Pages, Netlify) with build command `npm run build --prefix web` and output folder `web/dist`.

Local preview: `cd web && npm install && npm run build && python3 -m http.server 8788 --bind 127.0.0.1 --directory dist`.
