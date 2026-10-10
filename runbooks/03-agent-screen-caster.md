# Cut 03 — Agent-Screen caster (the live broadcast)

**You are an agent executing this runbook in `/workspaces/three.ws`.** Make the recorder
browser double as a **live three.ws "agent screen"**: while it funds the fleet, arms it, and
watches trades, it screenshots itself every ~6s and pushes those frames to
`/api/agent-screen-push`, so anyone watching `/agent-screen?agentId=<id>` sees it happen in
real time — and you also get the downloadable `.webm`. This is the most literal version of
"an agent on the three.ws browser feature doing all of this."

Read [00-overview.md](00-overview.md) for shared economics/safety. This cut runs the
**on-chain-truth fleet** (Cut 01) underneath and broadcasts the recorder on top.

## Verified broadcast contract (`api/agent-screen-push.js`)
- `POST https://three.ws/api/agent-screen-push`, JSON body:
  `{ "agentId": "<uuid>", "frame": { "data": "data:image/png;base64,...", "activity": "<=320 chars", "type": "screenshot" } }`
- Auth: `Authorization: Bearer <AGENT_JWT>` where the JWT is an API key with scope
  `agents:write` **for an agent you own** (or the operator `SCREEN_WORKER_SECRET`).
- Frame data ≤ ~600 KB base64; rate ≤ 6 fps; frame TTL 90s (push at least every ~80s to
  stay LIVE). Viewer: `https://three.ws/agent-screen?agentId=<uuid>`.
- Server needs Upstash Redis configured — **three.ws production already has it**, so pushing
  to the prod endpoint works. (Locally it would 503 without `UPSTASH_REDIS_REST_*`.)

## Inputs required from the operator
1. **3 SOL** + a **mainnet RPC URL** (as Cut 01).
2. **`AGENT_ID`** — the UUID of a real agent you own on three.ws.
3. **`AGENT_JWT`** — an API key for that agent with `agents:write`. Mint one at your
   three.ws dashboard (the `/agent-screen` "Deploy to the wall" wizard mints exactly this),
   or `POST /api/api-keys` with `scope:"agents:write agents:read"`.

## Steps

### 0–2. Stand up and fund the fleet (identical to Cut 01)
Do steps 0–2 of [01-onchain-truth.md](01-onchain-truth.md): environment setup, `gen`,
send 3 SOL to the funder, `fund`. Export `RPC`, and:
```bash
export AGENT_ID="<your agent uuid>"
export AGENT_JWT="<your agents:write api key>"
```

### 3. Start the live fleet + console (film target)
```bash
cd /workspaces/three.ws/packages/agent-sniper
SNIPER_ADMIN_TOKEN=local node scripts/fleet.js run --rpc "$RPC" --mode live --serve --yes &
# wait for: Console + API on http://localhost:8787/
```

### 4. Open the live viewer (so you can watch/confirm the broadcast)
Point a browser (or share the link) at:
```
https://three.ws/agent-screen?agentId=<AGENT_ID>
```
It will show OFFLINE until the first frame arrives in step 5.

### 5. Record AND broadcast at the same time
`CAST=1` turns on the frame-push loop; `reel.js` still records the local `.webm`:
```bash
OUT=/tmp/reel-caster CAST=1 CAST_INTERVAL_MS=6000 \
  AGENT_ID="$AGENT_ID" AGENT_JWT="$AGENT_JWT" \
  SCENE_FILE=runbooks/scenes/caster.json \
  node scripts/reel.js
```
While this runs: `/agent-screen?agentId=<AGENT_ID>` shows the live feed (console with the 33
agents, then three.ws `/theater` and `/play/arena`), and `/tmp/reel-caster/*.webm` captures
the same for download. The recorder logs `⇉ casting live…` and any push errors.

> To broadcast continuously (not just during a scripted reel), keep re-running step 5, or
> raise the per-scene `dwellMs` in `runbooks/scenes/caster.json` so each beat holds longer.
> Model for a bespoke long-running caster: `workers/agent-screen-worker/capture.js`.

### 6. Stop, sweep, done
```bash
kill %1
node scripts/fleet.js sweep --rpc "$RPC" --to <YOUR_WALLET> --yes
```
The agent screen goes OFFLINE automatically ~90s after the last pushed frame.

## What "done" looks like
- `/agent-screen?agentId=<AGENT_ID>` showed the full flow **live** (funding console →
  positions → three.ws theater/arena) with the caption/activity line updating per scene.
- A downloadable `.webm` of the same in `/tmp/reel-caster/`.
- Leftover SOL swept back.

## Limits
- `AGENT_ID` must be a **real** agent-identity you own; an invented UUID returns 403/404
  from the push endpoint and 404 from the stream.
- Appearing on the public `/agents-live` wall additionally requires the agent to be public;
  `/agent-screen?agentId=X` shows your frames regardless as long as the row exists and you
  own it.
- Pushing to **localhost** needs `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`; push
  to the **production** endpoint instead (default `PUSH_URL`) which already has Redis.
