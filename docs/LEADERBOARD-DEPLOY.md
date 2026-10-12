# Deploying the leaderboard (for the owner)

Everything below is typed by you in the **macOS Terminal app**, never in the chat. You never paste a token or key anywhere except Cloudflare's own sign-in page.

What you need: a free Cloudflare account (you create it yourself at https://dash.cloudflare.com/sign-up) and Node 22.18 or newer (already used by the project).

## 1. Sign in to Cloudflare

```text
cd /Users/owenzhao/Projects/flip-garden/server
npx wrangler login
```

`npx` downloads Cloudflare's `wrangler` tool on first use (this installs a tool on your machine; say no if you would rather not). A browser tab opens; sign in there and press Allow. The Terminal then says you are logged in. No token is shown or needed.

## 2. Create the storage

```text
npx wrangler kv namespace create LEADERBOARD
```

The output contains a line like `id = "abc123…"`. Open `server/wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with that value. (The id is not a secret, but do not commit it unless you want to.)

## 3. Check the settings in `server/wrangler.toml`

- `MARKET_FIRST_BLOCK` is a placeholder lower bound that has not been verified. It only decides the oldest start block a wallet may register. Leave it unless you know the real first block of the Kuru MON-USDC market.
- `MAX_WALLETS = "500"` caps registrations.
- `MAX_RPC_CALLS_PER_RUN = "40"` keeps each cron run inside the Free plan's 50 outgoing requests. On the Paid plan you may raise it (for example to 400).
- The cron schedule is `*/5 * * * *` (every five minutes). Deploying applies it; there is no separate step.

## 4. Publish

```text
npx wrangler deploy
```

It prints the Worker's address, like `https://flip-garden-leaderboard.<your-name>.workers.dev`. Use that in place of `<WORKER>` below.

## 5. Check the three endpoints

```text
curl -s https://<WORKER>/leaderboard
```
Expect `"rows":[]`.

```text
curl -s -X POST https://<WORKER>/register -H 'content-type: application/json' -d '{"address":"0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38","startBlock":112209462}'
```
Expect `"registered":true`. (This is the public example wallet already shown on the ledger page.)

Wait up to five minutes for the first scheduled run, then:

```text
curl -s https://<WORKER>/garden/0x39FdC1B554FCF0B7478E58ff671f3d0FEA64DA38
curl -s https://<WORKER>/leaderboard
```

Expect one row, `completedRoundTrips` 0 (that gate test never completed a round trip), and `catchingUp` false once the scan has reached the chain head.

To watch the scheduled runs live: `npx wrangler tail`. If a run is cut off with a CPU-limit message, lower `MAX_RPC_CALLS_PER_RUN` and deploy again, or switch the Worker to the Paid plan ($5 a month).

## 6. Optional hardening in the Cloudflare dashboard

Add a rate limiting rule for `POST /register` per client IP (Security → WAF → Rate limiting rules). The Worker itself only has a coarse global limiter and stores no IP address.

## Taking it down

`npx wrangler delete` removes the Worker. The KV namespace can be deleted in the dashboard (Storage & Databases → KV).

## What this does not do

It does not hold a key, send a transaction or change anything on the chain. It is not connected to the web page yet; wiring the page to the Worker's address is a separate step for the main session.


## Envio HyperSync for fast history (optional)

With an Envio API token the Worker reads Kuru logs through HyperSync in windows of 25,000 blocks (`ENVIO_WINDOW_BLOCKS` overrides it) instead of 90-block RPC windows, and it serves `GET /history/<address>?from=<block>` to the web page, which cannot hold the token. Without the token, or when HyperSync fails, everything runs on the public RPC as before.

Set the token once as a secret. Run this in the macOS Terminal app (not in the chat), from the `server/` folder; it asks for the value, so paste the token when prompted:

```text
npx wrangler secret put ENVIO_API_TOKEN
```

Then deploy as usual. To remove it: `npx wrangler secret delete ENVIO_API_TOKEN`. The token is never in `wrangler.toml`, in the page or in the repository.

Envio's free plan allows 15 HyperSync queries a minute (each query costs 1,000 of a 15,000 budget; the `x-ratelimit-*` response headers show it), so each cron run sends at most `ENVIO_QUERIES_PER_RUN` (default 10) queries and a `/history` call at most 9; a 429 answer is waited out once and then the scanner switches to the public RPC. Each cron run is also bounded by `MAX_RPC_CALLS_PER_RUN`. The default window is 100,000 blocks (`ENVIO_WINDOW_BLOCKS`). A HyperSync window of 100,000 blocks in a busy market holds roughly 3,000 logs (measured: 83,068 market and MarginAccount logs over 2,438,567 blocks); the Free plan's 10 ms CPU limit may cut a run that decodes many of them. Watch `npx wrangler tail`; if runs are cut off, lower `ENVIO_WINDOW_BLOCKS` or use the Paid plan.
