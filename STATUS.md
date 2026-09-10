# STATUS — Drimer (The Calibration Layer)

Last updated: 2026-09-09 (late) — deployed and live end-to-end for DoraHacks submission

## Live right now
- **Dashboard:** https://drimer-umber.vercel.app (Vercel, auto-deploys from GitHub `main`)
- **MCP server (5 tools) + orchestrator daemon:** https://drimer-production.up.railway.app (Railway, always-on)
  - `GET /health`, `POST /mcp`, `GET /sse`
  - Daemon polls ETH/FIFTEEN_MIN every 2 minutes, trades real (test) capital when edge clears
- **Repo:** https://github.com/ayodejiades/drimer — **currently private**, needs a decision before submission (flip
  public, or add specific reviewer handles as collaborators)
- **DB:** Neon Postgres, migration `20260909210224_init` applied, `RiskLimits id=1` seeded
- **Wallet:** `0x75b92367B628b5b05A2DdE329f42e16d46429aA0` — testnet-only, funded with 50 STT + self-minted test
  collateral, zero real-world value

## What's actually been verified live (not mocked)
- Real ETH 15-min market pulled from the live Shannon testnet indexer (`oracleQuestionId` in the 53000s range).
- Real IOC order placed and filled (`exchangeOrderId: 977677435906606274360` and later
  `3154393236604333342333`) — `TRADE`/`EDGE_CLEARED` decisions now appear in the live Decision Log, not just SKIPs.
- Real on-chain test-collateral self-mint via the SDK's `trader.faucet()`
  (`0xb4e9734ac3ac7da17adc114a9a3fdd79bd56916f57a13b4c855e39546aaf079f`).
- Backtest replay (`--days=90`) has been running in the background seeding ETH reliability history (well over
  1000 windows in as of this writing); BTC hasn't started yet — sequential per-asset, slow over Neon's network
  round trips. Not blocking: ETH alone already populates a credible reliability chart.

## Built today, in order
1. **Phase 2 (risk engine):** `src/decision/volatility.ts` chop filter, real `getWalletBalanceStt()` balance check,
   `EXCESSIVE_SPREAD`/`LOW_VOLATILITY_CHOP`/`INSUFFICIENT_GAS` added to the `DecisionReason` enum.
2. **Phase 4 (dashboard):** `SignalSandbox.tsx` interactive simulator, Economic Realization panel + benchmark
   badges on `ReliabilityChart.tsx`, Google Font fallbacks.
3. **README polish:** moved the dev tutorial to `TUTORIAL.md`, added a Competitive Positioning section, added
   `SUBMISSION.md` as a DoraHacks-form-ready draft.
4. **Real testnet fixes** (found by actually trying to trade, not just reading docs):
   - `dreamdexClient.ts` was pointed at guessed endpoints that don't match the installed
     `@somnia-chain/markets-sdk@0.28.1` — fixed to the SDK's real Shannon testnet config
     (`dev.smk.somnia.host` indexer, `api.infra.testnet.somnia.network` RPC, real `somniaShannon` chain export,
     baked-in `SOMNIA_TESTNET_ADDRESSES`).
   - `placeOrder` quoted IOC orders at the midpoint, which can never cross the spread — fixed to quote at
     bestAsk/bestBid + slippage.
5. **UI/UX pass:** trimmed Decision Log to 8 rows by default (was always rendering 50), fixed a real mobile
   horizontal-overflow bug (real 66-char hex `exchangeWindowId` didn't wrap — was invisible with the old shorter
   mock IDs), styled the Signal Sandbox range sliders to match the neobrutalist system (were default browser UI),
   reordered Signal Sandbox above Market View/Reliability, removed em-dashes from user-visible site copy, added a
   favicon/Apple icon/Open Graph image generated via Next's built-in image response (no external asset needed).
6. **Deployment:**
   - Vercel: had to move `tailwindcss`/`postcss`/`autoprefixer`/`prisma`/`tsx` from devDependencies to
     dependencies — Vercel's build-time `NODE_ENV=production` was stripping devDependencies on a redundant
     `npm install` inside the custom `buildCommand`, breaking the type check. Dropped the custom buildCommand
     now that `postinstall` runs `prisma generate`.
   - Railway: `railway.json`'s buildCommand/startCommand, `NIXPACKS_BUILD_CMD`/`NIXPACKS_START_CMD` env vars,
     and a `Procfile` were all tried and all ignored — Railway's builder ran `npm start` regardless. Since Vercel
     never invokes `npm start` (it serves the Next.js build output directly), repointed `start` itself at
     `npm run orchestrator:daemon & npm run mcp:dev`; `next start` moved to `dashboard:start` for local testing.
     Also fixed the MCP server to read Railway's injected `PORT` (was only reading `MCP_PORT`), and updated the
     Railway domain's target port to match.

## Not built yet
- Repo visibility decision (private vs public vs specific collaborators) — see "Live right now" above.
- Uploading the rendered demo video to YouTube/wherever the DoraHacks form wants, and pasting the link into SUBMISSION.md.
- BTC backtest history (ETH-only so far; not blocking, just less rich for BTC-specific queries).

## Demo video
- Rendered at `/Users/mac/Hackathons/drimer-demo/out/demo.mp4` — 81.2s, 60fps, narration via Kokoro TTS,
  normalized to -16 LUFS. Cover image at `out/cover.png`. Delivered to the user directly.
- Recording source: `docs/demo-path.json` drives Playwright against the live Vercel URL; `docs/actions.json`
  captured real click coordinates/timings; hand-tuned `story/story.json` (in the demo-video project) fixes
  narration content mismatches the auto-draft produced and sets explicit `clip` windows per beat (needed —
  omitting `clip` makes every beat start from the recording's frame 0; too-narrow `clip` windows run out of
  source footage mid-narration and go blank). Re-recorded with much longer `waitMs` holds between actions
  (~85-90s of real footage) once beats needing multi-second narration windows were identified as blank.
- Removed all "not a X" negative-framing phrasing and reworded every "live" (ambiguous heteronym — TTS was
  reading it as the verb "to live" instead of the adjective) to unambiguous alternatives, per user feedback.

## Current blocker
None. Everything above is live and verified with real requests, not just code review.

## Next action
1. Decide repo visibility and act on it.
2. Record the demo video.
3. Optionally let the backtest replay finish (or manually kick off a shorter BTC-only run) for richer BTC history.
