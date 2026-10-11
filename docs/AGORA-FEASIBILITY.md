# Agora bounty feasibility check (read-only, 2026-10-11)

Question: can Flip Garden meet the Agora "Best Mobile Trading App on Monad" bounty (USD 10,000, one winner)? Everything below was read in Chrome or with read-only calls. No transaction was sent, no key was used and no account was created.

## What the bounty requires (official page, read 2026-10-11)

A mobile application that authenticates users with Mera (Monad's passkey login), holds and displays a stablecoin balance in AUSD, and executes trades through Perpl. Judged on implementation quality, user experience and creative use of the three integrations together. Deliverables: a working demo of login by passkey, funding or viewing AUSD, and at least one Perpl trade, plus a video of up to 2 minutes. The page does not define "mobile application" (native or web).

## Verified

| Fact | Evidence |
|---|---|
| Mera works in a normal web page: a passkey gives 32 secret bytes (WebAuthn PRF), an ordinary EVM key is derived from them, and `toViemAccount` turns a signing session into a viem account that signs and broadcasts | mera.category.xyz getting-started and "Send a transaction with viem" |
| Phone browsers can do it: Safari and Chrome on iOS 18+ with iCloud Keychain, Chrome on Android with Google Password Manager, 1Password anywhere. Desktop Chrome only with Google Password Manager (the local profile has no PRF) | mera.category.xyz/authenticator-support |
| AUSD on Monad mainnet is `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals, total supply about 99.9 million | Agora docs "Contract Deployments"; on-chain `name`, `symbol`, `decimals`, `totalSupply` |
| AUSD can be bought inside our existing Kuru stack: Kuru Flow quotes 5 USDC to 5.001 AUSD, 20 USDC to 20.004 AUSD, 200 MON to 4.97 AUSD (quotes only, nothing executed) | `ws.kuru.io/api/quote`, read-only |
| Perpl is live on mainnet: the exchange contract `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` has code and holds about 3.30 million AUSD | on-chain `eth_getCode` and AUSD `balanceOf` |
| Perpl has a MON perpetual (market id 10; minimum order 1 MON), the collateral is AUSD, and opening an exchange account needs a deposit of at least 10 AUSD plus MON for gas | docs.perpl.xyz; `GET /api/v1/pub/context` |
| Perpl blocks these countries: BY, CU, GB, IR, KP, RU, SY, UA, US (China is not on the list) | `geo_block` in the public context |
| Perpl orders are on-chain limit-style primitives (OpenLong, OpenShort, CloseLong, CloseShort), about 100k gas to post | docs.perpl.xyz "Architecture" and "Order Types" |
| **Perpl's REST and WebSocket interfaces refuse a third-party web page.** From `owenzhao9.github.io` a normal `fetch` to the public context failed while a `no-cors` fetch succeeded (so the network path is fine), and the WebSocket handshake failed with code 1006; from `app.perpl.xyz` itself both worked | tested in Chrome |
| Kuru Flow (`ws.kuru.io`) and the Monad RPC accept calls from a third-party web page, unlike Perpl: from `owenzhao9.github.io` a token request and a quote of 5 USDC to AUSD returned 5.001028 AUSD, and `eth_chainId` returned 143 | tested in Chrome, 2026-10-11 |
| The Monad Foundation's own starter templates include Next.js PWAs next to React Native apps, so a web app is a recognised path in this hackathon (this does not say Agora's judges accept it) | hackathon.monad.xyz/resources |

## Competitor

Desk (github.com/frankolien/desk, README read 2026-10-11): a native iPhone app plus a browser version, Mera passkey, AUSD collateral, Perpl orders, copy trading, widgets, 553 Swift tests and 283 server tests, on TestFlight with a testnet build. By its own README it still lacks the demo video and a dated live mainnet fill. Its browser version places orders "through a relay that forwards your signed requests and cannot sign", which matches the Perpl finding above.

## What it would take (outline, not started)

1. Mera login in the page (viem account from a signing session) instead of a wallet extension.
2. AUSD funding through Kuru Flow quotes (swap USDC or MON to AUSD).
3. Perpl account creation and deposit (on chain), then a hedge order in the MON market. Two ways to place orders: a small relay server that only forwards signed requests (needs hosting beyond GitHub Pages), or direct on-chain calls to the exchange contract (needs the contract interface, not yet extracted).
4. A hedge view in the garden: the MON inventory that flip orders accumulate, and a Perpl short that offsets it. This idea is ours and unvalidated.
5. Safety rules change: with Mera the page holds a derived key in memory during a signing session. The rule "the page never sees a private key" in `docs/STAGE-D2-BRIEF.md` would become "the key exists only in memory during one signing session and is never stored or sent". That is the owner's decision.

## Not verified

- Whether a mobile web app counts as a "mobile application" for this bounty.
- Whether a project that logs users in with Mera may also use Dynamic (server or agent wallets) and stay eligible for the Dynamic bounty. The official pages for Dynamic, Privy and Mera contain no explicit exclusivity rule; the Mera bounty asks for Mera to be "the entire account layer".
- The exchange contract interface for direct on-chain orders, Perpl's fees in practice, and an end-to-end trade (nothing was executed).
