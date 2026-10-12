# Jev (TypeSafe AI): facts for the Gardener

Read on 2026-10-12 from docs.typesafe.ai (Introduction, Quick start, State, API reference, Confidence, Models, Legal) and typesafe.ai/legal (Master Customer Agreement and Acceptable Use Policy, both "last updated Sep 23, 2026"). Vendor statements, not independently measured unless marked.

## Request and response

- One endpoint: `POST https://api.typesafe.ai/v1/systemone`, headers `Authorization: Bearer <API_KEY>` and `Content-Type: application/json`.
- Body: `state` (a string, JSON object or array; required), `model` (required; `jev-latest` or a pinned id such as `jev-1.13.0`), `questions` (a map of named questions; required).
- Three question types: `choice` (pick one option from `criteria`, a map of option to description, at most 255 options), `score` (rate on 2 to 10 ordered levels), `noul` (yes/no probability). All questions in one call are evaluated in parallel and independently against the same state.
- A Choice answer is `{ type: "choice", choice, probabilities: {option: p}, confidence }`; probabilities sum to 1, `choice` is the highest-probability option.
- `confidence` for a Choice with n options is `(p_max - 1/n) / (1 - 1/n)`: 0 for an even split, 1 for certainty. Only the top probability counts.
- Errors: 401 bad key, 422 malformed request, 429 rate limit, 529 overloaded; back off and retry on 429/529.
- The response's `model` field names the versioned model that answered; aliases move when a new release ships, so a tuned threshold should pin the version.

## Limits, price, latency

- Jev 1.13 (`jev-1.13.0`, the target of `jev-latest` on 2026-10-12): 100K tokens per second and 80 requests per second per account, "adjusting dynamically"; 64k tokens per request (32k for state plus the longest question).
- Price: $0.042 per million input tokens; output tokens are free. A Gardener call is a few hundred input tokens (the docs' examples report 300 to 400 input tokens for one short question).
- Latency: the documentation pages read state no figure. The Gardener therefore times out at 2 s and does nothing on a timeout; real latency is to be measured from the Worker.
- Input is text only; English is the primary training language.

## Terms and data handling

- Jev is not trained on customer requests or responses (Models page, Privacy Policy). Zero data retention is offered to enterprise customers only, so requests from a normal account may be retained under the Data Processing Agreement.
- The Acceptable Use Policy and the Master Customer Agreement contain no clause on trading or financial decisions. They forbid, among other things, reselling the service as a standalone product, distillation, exceeding usage limits and unlawful use. The Worker therefore answers only the Gardener's own fixed questions and is rate-limited; it is not a general proxy.

## What the Gardener sends (the minimum)

The Worker's `POST /decide` accepts only named Gardener questions and a fixed set of numeric fields, validates every field and builds the Jev request itself (`src/gardener/questions.ts`). The state contains market and garden figures only:

| Field | Why |
|---|---|
| mid-price path (last 20 checks, in USDC per MON) and spread in basis points | trend and liquidity judgement |
| the bid's distance from the best bid in ticks, its age in blocks | whether to keep or re-place an order |
| free and locked USDC, MON inventory, hedge ratio and the mandate's range | whether to re-plant, harvest or adjust the hedge |
| failures in the last ten minutes | whether to wait after a failed move |

Never sent: the wallet address, transaction hashes, order ids, keys, the passkey session, or anything about the user. The Worker logs nothing about a request.

## Confidence routing (from the Confidence page, applied here)

The docs recommend three ranges: act automatically, ask a person, do nothing; thresholds scale with the stakes. The Gardener uses act at 0.85 or more, ask the user from 0.6 to 0.85, do nothing below 0.6, and the deterministic mandate decides what is allowed at all, whatever the confidence.

## Turning Jev on (the owner's steps, in the macOS Terminal app)

The endpoint is `POST /decide` on the existing leaderboard Worker (`server/src/decide.ts`). Until the key is set it answers 503 and the page offers only the rules-only Gardener.

1. Get an API key from the TypeSafe dashboard (your own account; accepting their terms is your decision).
2. Store it as a Worker secret. Wrangler asks for the value and reads it from the keyboard; it never appears in a file, the repository or the chat:

```text
cd /Users/owenzhao/Projects/flip-garden/server
npx wrangler secret put JEV_API_KEY
npx wrangler deploy
```

3. Run the comparison on the recorded data through the Worker (read-only; a few hundred Jev calls of a few hundred tokens each):

```text
cd /Users/owenzhao/Projects/flip-garden
node scripts/gardener-replay.ts https://flip-garden-leaderboard.photogif.workers.dev
```

4. Only if the Jev rows beat the rules rows (see the rule in `docs/FINDINGS.md`, "The Gardener"), set `DECIDE_URL` in `web/src/gardener.ts` to `https://flip-garden-leaderboard.photogif.workers.dev/decide`; the mandate card then offers "Jev" next to "Fixed rules".

To turn Jev off again: `npx wrangler secret delete JEV_API_KEY` (the Gardener then gets no answer and does nothing when set to Jev).
