# Sponsor bounties: requirements as published

Source: the bounty pages on https://hackathon.monad.xyz/tracks and the sponsor docs they link, read on 2026-10-12. All three are track-agnostic ("All tracks") and have the deadline shown on the platform (Oct 14, 2026 at 12:59 GMT+9). Each is added to the project on the platform by the owner, not by a session.

## 1. Best Use of Envio ($1,000, single prize)

Page: `/tracks/best-use-of-envio`

**Requirement.** Meaningfully use Envio's HyperIndex, HyperSync or HyperRPC to power real on-chain data that drives a core feature. "Not just installed, but actually driving a feature."

**Judging criteria.**
- Depth of use: multichain indexing, non-trivial schema, derived or aggregated entities, creative use of HyperSync for analytics scores higher than a single-event ERC-20 indexer.
- Working product: it runs, the data is live and correct.
- Originality.
- Craft: readable code, sensible schema, a repo someone else could pick up.

**Deliverables.**
- A working indexer or data pipeline built with Envio, deployed to Envio Cloud or self-hosted, with a public repo showing `config.yaml`, `schema.graphql` and event handlers, or HyperSync client code.
- A frontend, dashboard, agent, bot or API that consumes that data.
- A short demo (video or live link) showing the data flowing end to end.

**Asked at submission.** A description of how the project uses Envio; optional demo video up to 2 minutes.

**Sponsor docs (docs.envio.dev).**
- Monad mainnet (chain id 143) is supported: HyperSync `https://monad.hypersync.xyz` (or `https://143.hypersync.xyz`), HyperRPC `https://monad.rpc.hypersync.xyz` (or `https://143.rpc.hypersync.xyz`). Monad testnet (10143) is also listed.
- An API token is required on every request. HyperRPC takes it as a path segment: `https://143.rpc.hypersync.xyz/<api-token>`. Tokens are created in the Envio dashboard.
- HyperRPC is a read-only JSON-RPC drop-in. Supported methods include `eth_getLogs`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockReceipts`, `eth_getTransactionReceipt`. Billing: $4 per million JSON-RPC calls, $1 monthly minimum. Marked as under development and not audited.
- HyperSync is the recommended and faster path, with client libraries for Node.js, Python, Rust and Go; HyperIndex is a full indexer (schema, handlers, GraphQL) built on HyperSync.

## 2. Bring Any-Chain Liquidity to Monad (Aurora Intents, $5,000: $2,500 / $1,500 / $1,000 plus a support bundle)

Page: `/tracks/bring-any-chain-liquidity-to-monad`

**Requirement.** Integrate Aurora Intents (powered by NEAR Intents) into a Monad app for any-chain deposits, swaps or deposit-and-execute flows, using at least one of: Intents Connect, Swap API, Intents Deposits.

**Judging criteria.**
- A working integration of at least one product, demoed live. "An actual working flow, not mocked."
- Removes a real cross-chain friction point for the end user.
- Technical quality: correct settlement and refund handling, clean UX with the cross-chain complexity hidden, an easy flow without unnecessary actions.
- Fit and creativity within the chosen track.
- Bonus: multi-chain source coverage, contract-level composability via Intents Connect, a Confidential Intents use case.

**Deliverables.**
- A working integration of at least one product, demoed live.
- A live cross-chain flow showing funds arriving from another chain and being used inside the Monad app.
- The standard submission items (public repo, technical demo video, pitch video, live product link).

**Asked at submission.** A description of the integration; optional demo video up to 2 minutes showing a live cross-chain flow.

**Sponsor docs (docs.intents.aurora.dev).**
- Monad is listed as supported for both source and destination, for Intents Deposits and for the Swap API. Monad assets in the Swap API list: MON (`nep245:v2_1.omni.hot.tg:143_11111111111111111111`), USDC at `0x754704bc059f8c67012fed69bc8a327a5aafb603` (`nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx`), USDT0 at `0xe7cd86e13ac4309349f30b3435a9d337750fc82d` (`nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et`). AUSD is not in that table; the live list is `GET /api/tokens/{apiKey}`.
- Swap API flow (REST, base `https://intents-api.aurora.dev`, API key as a path segment; the key is not secret and may ship in client code):
  1. `GET /api/tokens/{apiKey}` for asset ids.
  2. `POST /api/quote/{apiKey}` with `swapType`, `originAsset`, `destinationAsset`, `amount`, `slippageTolerance`, `recipient`, `recipientType: DESTINATION_CHAIN`, `refundTo`, `refundType: ORIGIN_CHAIN`, `deadline`. `dry: true` prices without reserving a deposit address. The response carries `amountOut`, `minAmountOut`, a deadline and a unique `depositAddress`.
  3. The user sends the origin asset to `depositAddress` from any wallet before the deadline (no approval or contract call on our side). Optional `POST /api/deposit/submit/{apiKey}` with the transaction hash speeds up detection.
  4. `GET /api/status/{apiKey}?depositAddress=...` until `SUCCESS`, `REFUNDED` or `FAILED`. `GET /api/transactions/{apiKey}?walletAddress=...` for history, `GET /api/incidents/{apiKey}` for active incidents.
- `swapType`: `EXACT_INPUT`, `EXACT_OUTPUT`, `FLEX_INPUT`, `ANY_INPUT` (the last one powers Intents Deposits and persistent addresses). Persistent deposit addresses have their own endpoints.
- Fees: set per API key in the client portal; split 60% integrator / 40% Aurora, maximum 500 bps. API keys are created in Intents Studio.
- Intents Connect (SDK `@aurora-is-near/intents-connect`) can run destination-chain steps after a deposit; its docs show EVM, Solana and Sui examples, none for Monad. Not needed for a plain deposit.

**Fit with this app.** The Swap API or Intents Deposits path needs no on-chain call from our side: the origin-chain wallet sends a plain transfer to a deposit address, and funds arrive at the user's Monad account, after which the existing planting preview takes over. Nothing in the docs blocks this. One point to settle with the owner: the origin-chain wallet is a separate wallet (for example on BNB Chain or Base) and signs its own transfer in its own pop-up; this app cannot and should not sign for it.

## 3. Best Mera-Powered UX on Monad (Monad Foundation, $2,500, single prize)

Page: `/tracks/best-mera-powered-ux-on-monad`

**Requirement.** An app where Mera is the entire account layer: no seed phrase, no wallet extension, no custody backend. "The winner is the app where the user never notices there's a blockchain underneath."

**Judging criteria.**
- Time-to-first-transaction: taps and seconds from the landing page to a confirmed Monad transaction.
- Session design: sensible scoping of prompt-free versus re-prompt actions, clean session-expiry UX.
- The stateless test.
- Bonus: combining Mera with the broader account stack (gas sponsorship, intents, recovery flows, smart-account patterns, cross-chain accounts).

**Deliverables.**
- Deployed on Monad testnet or mainnet with real transactions and a live demo.
- One-prompt onboarding: a single passkey ceremony, no seed phrase, extension install or email/OTP step.
- Prompt-free signing via Mera signing sessions with a clearly scoped session.
- Must pass the stateless test: judges clear local storage or open the app on a fresh device mid-demo, and identity and access must fully reconstruct from the passkey (plus untrusted storage if used).

**Asked at submission.** A description of how Mera is the entire account layer; optional demo video up to 2 minutes focused on UX.

**What "stateless" means for the code (from the Mera docs, mera.category.xyz).**
- Every ceremony recomputes the same keys from the passkey's PRF output with a fixed salt, on every device the passkey syncs to; no secret is stored anywhere. Sign-in is `getPasskeyPrfOutput({ rpId })` and works without a stored credential id (the browser offers any discoverable passkey for the rpId). Storing the credential id only pins later sign-ins and must not be required.
- So the app may keep nothing it cannot rebuild: the address comes from the derived key, and anything else (session scope, settings, history) must either be recomputable from the chain and the key or live in untrusted storage that can be empty.
- A signing session holds a raw key in memory until `end()`; it does not contact the authenticator. After `end()` the next signature needs a fresh ceremony and prompt. Docs advise holding a session for a burst of work only, and not holding one at all for occasional signing.
- Security notes: keys are software keys in page memory; any script under the rpId can reach them; a domain migration breaks every account, so the rpId must stay fixed; losing the passkey without a backup loses the account.

**Sibling bounty (not in scope).** "Mera: One Passkey, Many Keys" ($2,500) is for the most creative non-wallet use of the PRF-derived key material.

## Conflicts and decisions for the owner

1. Envio token. HyperRPC and HyperSync both require an API token. It must live in the Worker as a secret; the web page then has to read history through the Worker, not directly. Using HyperRPC (`eth_getLogs`) needs no new dependency; using the HyperSync client library would add `@envio-dev/hypersync-client` (name to be verified, size to be measured) and needs the owner's approval first.
2. Aurora API key. Not secret, but created by the owner in Intents Studio; the live asset list decides whether AUSD or USDC is the landing asset on Monad.
3. Mera as the only account layer means removing the browser-wallet connect buttons: the bounty text says "no extension", so there is no reason to keep that path.
