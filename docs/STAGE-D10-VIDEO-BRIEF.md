# Stage D, milestone 10: the two submission videos and the full platform submission (brief for a session)

Read first: `docs/HANDOFF.md`, `CLAUDE.md`, `docs/submission/` (platform texts and `DEMO-SCRIPT.txt`), `docs/FINDINGS.md`, `README.md`. Work in the main checkout on `main` (no worktree): this milestone ends with a push and the platform submission, both pre-approved by the owner.

## The owner's request (2026-10-12)

Make the technical demo video with Remotion (or HyperFrames if it fits better; read its docs first), make the pitch video, upload both, and complete the whole submission on https://hackathon.monad.xyz/project. The owner approved adding Remotion (or HyperFrames) as a dependency for this, in a new top-level folder `video/` only (its own `package.json`, exact versions, never imported by `web/` or `src/`); record the versions in `docs/STAGE-D3-BRIEF.md` with the other approved dependencies. Check Remotion's licence terms and tell the owner in one line.

## Platform rules (from the platform, read 2026-10-10; re-check on the live page before uploading)

- Technical demo video: at most 3 minutes; **it must show the real working product, not slides or a code walkthrough**.
- Pitch video: at most 2 minutes.
- Both are links (YouTube, Loom, Vimeo or another video host).
- Texts about the project state only what it is and does: no evaluative wording, no personal information about the owner (no name, face, voice, location).

## Style reference and narration (owner, 2026-10-12)

- Reference: https://x.com/Kkkatia1/status/2109546367517684123 (another Monad Metropolis entry; its post says the script, voice, subtitles, music and animations were all made with an AI model). Match that level: cinematic pacing, an English voice-over, burned-in English subtitles in sync with the voice, light background music, smooth animated transitions. Do not copy its content or assets.
- **English narration is required for both videos.** Use a synthetic voice, never the owner's voice. Default: the macOS built-in `say` command with the best installed English voice (`say -v '?'` lists them; a Premium or Enhanced voice if present), rendered to audio files per scene; tell the owner if a better voice needs a download from System Settings. A paid text-to-speech service only if the owner provides one; its key goes in an environment variable typed by the owner in the macOS Terminal, never in chat or files.
- Music: generate a simple ambient track in code, or use a track whose licence clearly allows reuse (CC0); never download from an unknown source without telling the owner.
- Subtitles come from the same script text as the narration, timed to each audio clip.

## 1. Technical demo video (about 2:30, English voice-over and subtitles)

Real footage of the live product, composed in Remotion with titles and captions. Update `docs/submission/DEMO-SCRIPT.txt` for the current product first (Mera-only sign-in, Deposit tab, 3D garden, Gardener) and follow it.
- Read-only parts you can capture yourself in the owner's Chrome or a headless browser: Ledger with the example wallet and with `0xdEbE9fCBc6A14963f555c63045ec8885D5f619EA` (start block 112471857, real round of 2026-10-11, 7 checks at difference 0, the 3D garden card), Board.
- Signed-in parts (Plant preview, Hedge plan, Gardener mandate card, Deposit preview): the owner signs in once with the passkey (Touch ID), then you drive previews only. **Never press Sign and send, Approve, Open the hedge, Start the Gardener or Get the deposit address**: only previews and Cancel. If a part needs a real transaction on screen, use the owner's own recording or the transaction pages on the explorer for the 2026-10-11 hashes in `docs/FINDINGS.md`.
- Show real numbers only; captions describe what is on screen. Render MP4 1080p.

## 2. Pitch video (at most 2:00, English voice-over and subtitles)

Motion graphics in Remotion, built from the project texts in `docs/submission/` and real product screenshots: what Flip Garden is, the problem it addresses, how it works (plant, grow, hedge, ledger, Gardener), why Monad, the live link. Project only, no team or personal details. Render MP4 1080p.

## 3. Upload and submit

- Upload both videos as **unlisted** to a host the owner is signed in to in Chrome (YouTube preferred). Ask the owner which account if more than one appears; do not create accounts.
- On the platform: paste both links, update the one-liner, description, go-to-market and judge access for the current product (mirror them in `docs/submission/`), add a progress update, save, then use "Review entry" and complete the submission. Confirm on the page that the entry can still be edited afterwards and tell the owner.
- Sponsor bounties: do not register any without the owner's yes; prepare a short list with each bounty's exact requirements from its live page (candidates in `docs/HANDOFF.md`).

## Red lines

Never sign or send a transaction, never use a key, never create an account. No personal information in any video or text. No new dependency outside `video/`. Push `main` after tests pass (pre-approved). Reply to the owner in Chinese, conclusion first; in the repository everything is English.
