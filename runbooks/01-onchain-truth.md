# Cut 01 — On-chain truth (runnable now)

**You are an agent executing this runbook in `/workspaces/three.ws`.** Produce a screen
recording of 33 throwaway wallets being funded from one wallet and running the pump.fun
sniper live with tiny 0.002 SOL buys. This cut films **our own** sniper console (showing
the exact 33 agents), Solscan proof of the real wallets, and three.ws `/theater` `/trades`
as branded b-roll. 100% honest — these are the real wallets and the real trades.

Read [00-overview.md](00-overview.md) for shared economics, safety, and cleanup. Everything
here is self-contained.

## Inputs required from the operator
1. **3 SOL** sent to the funder wallet (address printed in step 2).
2. A **mainnet RPC URL** → export it once: `export RPC="https://..."`.

## Steps

### 0. Environment (skip if already set up)
See [00-overview.md](00-overview.md) → "One-time environment setup". Then:
```bash
cd /workspaces/three.ws/packages/agent-sniper
```

### 1. Generate the fleet (skip if `~/.three-ws-fleet/keys.json` already exists)
```bash
node scripts/fleet.js gen --n 33
node scripts/fleet.js plan            # shows funder address + archetype spread
```
Back up `~/.three-ws-fleet/keys.json` — it is the only copy of the throwaway keys.

### 2. Fund the funder, then fan out to 33
Send **3 SOL** to the funder address from step 1. Confirm it landed, then disburse:
```bash
node scripts/fleet.js balance --rpc "$RPC"        # funder should show ~3 SOL
node scripts/fleet.js fund    --rpc "$RPC" --yes   # ~0.09 SOL → each of 33 (batched, 8/tx)
node scripts/fleet.js balance --rpc "$RPC"        # verify all 33 funded
```

### 3. Point the Solscan scene at the real funder
The scene file `runbooks/scenes/onchain-truth.json` has a Solscan scene. Replace its
address with **your** funder address (from `plan`) so it proves your wallets:
```bash
FUNDER=$(node -e "console.log(require(require('os').homedir()+'/.three-ws-fleet/keys.json').funder.address)")
node -e "const f='runbooks/scenes/onchain-truth.json';const s=require('fs').readFileSync(f,'utf8');require('fs').writeFileSync(f,s.replace(/account\/[A-Za-z0-9]+/,'account/'+process.env.FUNDER))" FUNDER="$FUNDER"
```

### 4. Start the live fleet WITH the console (the thing you film)
`--serve` mounts the package's HTTP API + web console over this exact fleet, on `:8787`.
Run it in the background:
```bash
SNIPER_ADMIN_TOKEN=local node scripts/fleet.js run --rpc "$RPC" --mode live --serve --yes &
# wait until it prints:  Console + API on http://localhost:8787/
```
Open `http://localhost:8787/` to confirm you see the 33 agents, live activity, and
positions filling. Let it run a few minutes so real buys land before recording.

### 5. Record the reel
```bash
OUT=/tmp/reel-onchain SCENE_FILE=runbooks/scenes/onchain-truth.json \
  node scripts/reel.js
```
This films, in order: the console (33 agents + live decisions), the console again (positions/PnL),
Solscan of your funder, three.ws `/theater`, three.ws `/trades` — each with a caption bar.
Output: `/tmp/reel-onchain/*.webm` + one PNG per scene + `manifest.json`.

> Tip: run step 5 a few times while the fleet trades to capture different moments, or add
> more scenes to the JSON (e.g. a specific agent wallet on Solscan showing its buys). To
> film only a subset: `SCENES=console,trades node scripts/reel.js`.

### 6. Stop, sweep, done
```bash
kill %1                                             # stop the fleet
node scripts/fleet.js sweep --rpc "$RPC" --to <YOUR_WALLET> --yes
```

## What "done" looks like
- A `.webm` showing the console with 33 named agents scoring live pump.fun launches and
  opening real positions, Solscan proving the on-chain funding fan-out, and the three.ws
  theater/trades pages as branded context.
- No console errors in the recorder output; `Scenes ok: N/N`.
- Leftover SOL swept back to your wallet.

## Honesty / limits
- The three.ws `/theater` and `/trades` scenes show **platform-wide** activity, not
  specifically our 33 — they're branded b-roll. The console + Solscan scenes are the ones
  that prove *these exact wallets*. Caption accordingly; don't imply the theater avatars
  are our fleet (that's Cut 02).
