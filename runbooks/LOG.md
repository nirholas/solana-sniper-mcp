# Process Log — 33 AI Agents on three.ws

Append-only. Newest at the bottom. One entry per meaningful step; note what was done,
what was recorded, and what's next. Pairs with [PLAN.md](PLAN.md).

---

## 2026-07-03

**Phase 0 — Docs & setup / tooling.**

- Mapped the three.ws surfaces (sniper, wallets, agent-screen, arena/theater/terminal)
  and the standalone `@three-ws/agent-sniper` engine (adapters, hooks, presets).
- Built the fleet tooling in `packages/agent-sniper/scripts/`:
  - `fleet.js` — `gen | plan | balance | fund | run | sweep`; `--serve` mounts the
    package console over the live fleet; `--telegram` + `--allow-mayhem` flags.
  - `reel.js` — Playwright recorder (video + per-scene PNG + caption bar); `CAST=1`
    broadcasts frames to a three.ws agent-screen.
  - `telegram.js` — live per-trade buy/sell feed + 15-min summary.
  - `mayhem-filter.js` — excludes pump.fun Mayhem tokens via `isMayhemMode`.
  - Runbooks `00–03` (overview + on-chain-truth / platform-native / caster cuts) + scenes.
- **Verified:**
  - Sniper pipeline in simulate — 33 strategies armed, scored live pump.fun mints, guards
    fired (`insufficient_sol`, `global_throttle`). Recorded a `.webm` + stills of live
    three.ws `/trades`, `/theater`, `/play/arena`, `/terminal`, `/pulse`.
  - **Mayhem filter on LIVE mints** via `@nirholas/pump-sdk` + Helius: correctly read
    `isMayhemMode` (one live token flagged `true` → excluded; normals passed). Rule proven.
  - Telegram message formatting (buy/sell/PnL/tx links) dry-run.
- **Secrets** (owner-provided, shared in chat → to rotate): stored in `~/.three-ws-fleet/env`
  (chmod 600). Identified: funder key = `niChP…Keevy` (base58); 64-byte symmetric secret =
  likely `WALLET_ENCRYPTION_KEY`/`JWT_SECRET` (not a keypair); `DATABASE_URL` (Neon);
  Helius RPC. No launcher-master keypair → fund from funder directly.
- 33 throwaway wallets generated (funder `GiE8Rv…`) — **pre-vanity**; will be replaced by
  vanity keypairs in Phase 2.

**UI recon (owner directive: do EVERYTHING via the real three.ws UI, recorded).**
- Traced the full human click-path in source — all core steps are UI-doable:
  `/register` → `/create-agent` (avatar from gallery) → `/agent/{id}/edit` Wallet panel →
  **arm at `/dashboard/sniper`** (full fields + stop-loss + Arm button; NOT `/oracle/arm`,
  NOT the broken agent-edit "Alpha Hunt") → watch at `/agent-screen`/`/terminal` →
  optional manual buy at `/terminal`.
- **Honest gaps flagged to owner:** (1) **vanity wallets not UI-doable** — UI makes random
  wallets, no key import; (2) **funding fan-out is external** (on-chain transfer from the
  funder, not a three.ws click); (3) **Avaturn not in normal UI** (gallery/upload only).

**Phase 1 — real-UI execution begins.**
- Owner provided the three.ws account login (`three-ws`) → stored in `~/.three-ws-fleet/env`.
- Owner rule reaffirmed (4×): do EVERYTHING via the real three.ws UI; flag any deviation.
- Vanity default set to **random UI wallets** (pure-UI) unless owner opts into the one
  non-UI import step.
- **Signed in via the real `/login` UI** (Playwright, recorded): filled form → landed on
  `https://three.ws/dashboard` as `three-ws`. Video + screenshots captured.
  Driver: `scripts/ui-login.mjs`.
- Hardened login (wait for the field before filling; `waitForURL` for success) after a
  timing-race failure (blank page). **Session persisted** to `~/.three-ws-fleet/state.json`
  (chmod 600) — reused by all later steps so we log in once. Driver: `scripts/ui-session.mjs`.
- **Captured the real `/create-agent` wizard** signed in: 5-step flow. Selectors:
  `#magic-input`+`#magic-go` (describe→Generate), `#f-name`, `#f-description`,
  `#f-tags-input`, `#btn-next`; avatar step + review follow. $THREE CA present in footer.
- ✅ **Agent #1 "Scout 01" CREATED via the real 5-step UI wizard, recorded.** Rigged
  **Saga** avatar (starter gallery), Pump.fun market-intel skill enabled, published.
  Platform confirmed "Scout 01 is ready — its own wallet and on-chain identity."
  Driver: `scripts/ui-create-agent.mjs` (5-step walk: basics → body → skills → persona →
  review → Create). Note for batch: success screen stays on `/create-agent`; capture the
  agent id via the "Open agent" button, not a URL change.
- Scout 01: id `0c7cdd77-a357-4f57-94aa-f4f50ef0432a`, wallet
  `EZm1jcG52zwW3uGoZB1ZanfbXyaD2NFvaKS4SH37Gnew`. Driver: `scripts/ui-agent-info.mjs`.
- **Correction (owner told me to flag deviations):** vanity wallets ARE UI-doable — the
  dashboard Agents list has a **"+ Vanity"** button per agent. My earlier "vanity not in
  the UI" was wrong (I'd only checked the agent-edit wallet panel). Vanity can be pure-UI.
- **Mayhem enforcement re-verified:** the PROD worker `workers/agent-sniper/executor.js`
  runs `mayhemGate` (gate 0, `SNIPER_MAYHEM_FILTER=1`) — the UI-armed path IS protected.
  Corrected the stale `no-mayhem-pumpfun-tokens` memory + MEMORY.md.
- **Execution reality (`/api/sniper/status`):** prod worker **DOWN** (~2.75h stale beat),
  mode live/mainnet, **34 strategies already armed**, 0 open positions, 0 funded today.
  → Arming Scout 01 now is **inert/safe** (no live worker + empty wallet). To trade, I'll
  run the platform worker myself: `SNIPER_MAYHEM_FILTER=1`, **auto-fund OFF**, fund only
  Scout wallets from `niChP` (tiny), one instance, recorded. The 34 pre-existing armed
  strategies stay unfunded/idle.
- ✅ **Scout 01 sniper strategy configured via the real UI** ("Arm an agent +" modal):
  new_mint trigger, **0.002 ◎/trade, 0.020 ◎ daily**, oracle-conviction min 55 (wires the
  oracle intelligence). Driver: `scripts/ui-arm-sniper.mjs`. Card shows **Disarmed** —
  platform gates arming on an unfunded wallet ("⚠ low"). Zero spent.
- Balances (read-only): **niChP funder 2.9457 SOL** (ready), Scout 01 0 SOL.
- **Single-agent setup is fully proven via the real UI, recorded, up to the money line.**

**GO — owner authorized full end-to-end, no questions ("make me proud"). THE SWARM.**
Requirements ledger: 33 agents "Swarm 1..33", rigged avatars, vanity wallets, real-UI only
(flag deviations), pump.fun sniping 0.002/0.02 SOL, NO Mayhem, oracle+intel (Fable held till
API key funded), fund from niChP, record ALL continuously until last buy, $THREE promoted.

**Phase A — creation (RUNNING):** `scripts/ui-create-swarm.mjs` batch-creating Swarm 1..33 via
the real 5-step wizard (rotating starter avatars, market-intel skill on), one continuous video,
idempotent. Swarm 1 ✓, Swarm 2 in progress at log time.

**Phase E infra — VERIFIED runnable (the make-or-break):**
- DB reachable (Neon) — 2,687 agent_identities; Swarm agents landing.
- **WALLET_ENCRYPTION_KEY confirmed correct** — decrypted Scout 01, derived pubkey == stored
  (EZm1…Gnew). The worker can decrypt Swarm wallets and sign trades.
- Worker dep chain resolves (`@neondatabase/serverless`, `@nirholas/pump-sdk`, config.js import OK).
- Plan: run `workers/agent-sniper` locally vs Neon, `SNIPER_MODE=live`, `SNIPER_MAYHEM_FILTER=1`,
  `SNIPER_AUTO_FUND=0`, one instance; fund ONLY Swarm wallets → only they trade (others idle).

**Pipeline:** A create → B vanity (UI) → C fund from niChP → D arm (UI) → E run worker + record
continuously until last buy → F sweep + rotate secrets. Fable layer deferred (API key unfunded).

**Phase E — worker boot VERIFIED (simulate, vs live Neon):** `node workers/agent-sniper/index.js`
boots clean — `mayhem filter enabled=true`, `feed connected` (live pump.fun), strategies refreshed,
intel/radar/market-maker armed, live candidate scoring with `has_socials`/`mc_usd` reasons,
`intel llm:false` (Fable off, as intended). The engine works end-to-end against the real DB.
Scripts ready: `scripts/fund-swarm.mjs` (DB-driven fund from niChP), funding-verified.
Note: currently 1 non-Swarm armed strategy in DB (agent 4959a139…) — check its balance before
live; fund ONLY Swarm so only Swarm trades.

**Open / next (blocking, owner decisions):**
- Vanity vs random UI wallets? (vanity ⇒ a non-UI import step).
- Account: register a fresh three.ws account in-UI, or use the owner's login?
- Then execution shifts to a **recorded single-agent UI dry-run** (register → create →
  arm → watch) to prove the human-UI + continuous-recording flow before scaling to 33.
- Retire the CLI-first framing of runbooks 01–03; keep as fallback only (owner-flagged).
