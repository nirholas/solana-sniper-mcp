# Cut 02 — Platform-native (the pretty one)

**You are an agent executing this runbook in `/workspaces/three.ws`.** Provision the 33
throwaway agents as **real three.ws platform agents** so they star in `/theater` and
`/play/arena` with their own 3D avatars, reacting to their own real pump.fun buys. Record
that branded UI.

This cut needs **platform secrets** (below). It touches the production database — treat it
as an operator action. Read [00-overview.md](00-overview.md) for shared economics/safety.

> **Verified env-var name:** the wallet at-rest key is **`WALLET_ENCRYPTION_KEY`**
> (`api/_lib/secret-box.js`). It must be the SAME value in the API and the worker, or the
> worker cannot decrypt agent keys and every buy fails silently.

## Inputs required from the operator
1. **3 SOL** + a **mainnet RPC URL** (`SOLANA_RPC_URL` or `HELIUS_API_KEY`).
2. `DATABASE_URL` — the production Postgres (or a staging clone).
3. `WALLET_ENCRYPTION_KEY` — matching the value the API uses.
4. `JWT_SECRET` — required by the worker config.
5. `LAUNCHER_MASTER_SECRET_KEY_B64` (or `PUMP_X402_LAUNCHER_SECRET_KEY_B64`) — a
   SOL-funded master wallet, **only if** you want the worker's auto-funder to fund agents.
   Otherwise you fund each agent address manually (step 3).

## Important platform constraints (verified)
- **A user may own many agents.** The old one-agent-per-user unique index
  (`agent_identities_user_unique`) was **dropped on 2026-05-13**
  (`api/_lib/migrations/2026-05-13-drop-agent-identities-user-unique.sql`) so the
  dashboard can create multiple agents per owner. 33 Scouts do **not** require 33
  users — but the SQL below still creates one user per Scout for a clean 1:1
  mapping and stable, email-keyed idempotency. Do **not** use
  `on conflict (user_id)` on `agent_identities`; there is no matching constraint
  and it errors with `no unique or exclusion constraint matching the ON CONFLICT
  specification`.
- **Appearing on `/play/arena` requires a `agent_sniper_positions` row**, not just an armed
  strategy. Let the live worker open positions, or the arena stays empty for these agents.
- **Appearing on `/theater` requires `is_public = true`** and, for a real 3D body, an
  `avatar_id` linking to a public `avatars` row with a `storage_key` (the GLB in R2).
  `/theater` reads the roster from `/api/agents/public` and resolves each body from
  `GET /api/agents/:id → avatar_model_url`, which is `publicUrl(avatars.storage_key)`
  for the linked `avatar_id` (mannequin fallback when absent). Note: the `avatars`
  table has **no `model_url`/`is_public` columns** — the GLB is `storage_key` and
  publicness is `visibility='public'`.

## Steps

### 1. Migrate (once)
```bash
cd /workspaces/three.ws
psql "$DATABASE_URL" -f api/_lib/migrations/20260615020000_agent_sniper.sql   # or: npm run db:migrate
```

### 2. Create 33 users + 33 public agent identities
Pick a public avatar with a 3D model so they render with a body in the theater:
```bash
AVATAR_ID=$(psql "$DATABASE_URL" -tAc "select id from avatars where storage_key is not null and visibility='public' and deleted_at is null and model_category='avatar' order by view_count desc nulls last limit 1")
echo "using avatar $AVATAR_ID"
psql "$DATABASE_URL" <<SQL
do \$\$
declare uid uuid; nm text; i int;
begin
  for i in 1..33 loop
    nm := 'Scout '||lpad(i::text,2,'0');
    -- users.email is UNIQUE, so this is the real idempotency key across re-runs
    insert into users (email) values ('scout'||lpad(i::text,2,'0')||'@fleet.three.ws')
      on conflict (email) do update set email=excluded.email returning id into uid;
    -- agent_identities.user_id is NOT unique (agent_identities_user_unique was
    -- dropped 2026-05-13), so guard on (user_id, name) instead of ON CONFLICT.
    insert into agent_identities (user_id, name, description, is_public, avatar_id)
      select uid, nm, 'Throwaway sniper fleet agent', true, '${AVATAR_ID}'
      where not exists (select 1 from agent_identities where user_id = uid and name = nm);
    -- re-assert the fields a re-run should refresh (idempotent)
    update agent_identities set is_public = true, avatar_id = '${AVATAR_ID}'
      where user_id = uid and name = nm;
  end loop;
end \$\$;
SQL
psql "$DATABASE_URL" -tAc "select id,name from agent_identities where name like 'Scout %' order by name"
```

### 3. Generate + attach a Solana wallet to each, and fund it
`getOrCreateAgentSolanaWallet(agentId)` in `api/_lib/agent-wallet.js` generates + stores an
encrypted wallet on the identity. Run it for each Scout, then fund each address with 0.09 SOL
from any wallet (there is **no public HTTP funding route** — send SOL directly, or set the
master secret and let the worker's auto-funder top them up):
```bash
DATABASE_URL="$DATABASE_URL" WALLET_ENCRYPTION_KEY="$WALLET_ENCRYPTION_KEY" \
node -e '
import("./api/_lib/agent-wallet.js").then(async (m)=>{
  const { query } = await import("./api/_lib/db.js");
  const { rows } = await query("select id,name from agent_identities where name like $1 order by name",["Scout %"]);
  for (const a of rows) {
    const w = await m.getOrCreateAgentSolanaWallet(a.id);
    console.log(a.name, w.address);   // fund each of these with ~0.09 SOL
  }
});'
```
Fund the printed addresses (total ~3 SOL). If using the master-secret auto-funder instead,
skip manual funding — the worker tops each agent to `SNIPER_AUTO_FUND_TARGET_SOL` in step 5.

### 4. Arm a sniper strategy for each agent
Direct SQL is the simplest (bypasses session/CSRF); supply `user_id` explicitly:
```bash
psql "$DATABASE_URL" <<'SQL'
insert into agent_sniper_strategies
  (agent_id, user_id, network, enabled, trigger, per_trade_lamports, daily_budget_lamports,
   stop_loss_pct, take_profit_pct, max_concurrent_positions, slippage_bps, require_socials)
select a.id, a.user_id, 'mainnet', true, 'new_mint', 2000000, 20000000, 30, 60, 2, 500, true
from agent_identities a where a.name like 'Scout %'
on conflict (agent_id, network) do update set
  enabled=true, per_trade_lamports=excluded.per_trade_lamports,
  daily_budget_lamports=excluded.daily_budget_lamports, updated_at=now();
SQL
```
(`per_trade_lamports` 2000000 = 0.002 SOL; `daily_budget_lamports` 20000000 = 0.02 SOL.)
Alternatively POST each to `/api/sniper/strategy` with a bearer token (no CSRF for machine
callers) — see `api/sniper/strategy.js` for the full field list.

### 5. Run the DB-coupled worker (live, ONE instance only)
```bash
cd /workspaces/three.ws
DATABASE_URL="$DATABASE_URL" JWT_SECRET="$JWT_SECRET" \
WALLET_ENCRYPTION_KEY="$WALLET_ENCRYPTION_KEY" HELIUS_API_KEY="$HELIUS_API_KEY" \
SNIPER_MODE=live SNIPER_NETWORK=mainnet SNIPER_MAX_GLOBAL_BUYS_PER_MIN=10 \
SNIPER_AUTO_FUND=1 LAUNCHER_MASTER_SECRET_KEY_B64="$LAUNCHER_MASTER_SECRET_KEY_B64" \
node workers/agent-sniper/index.js &
```
Run **exactly one** instance (budget/concurrency guards are in-process only). Rehearse with
`SNIPER_MODE=simulate` first — zero SOL, full pipeline. Watch until the Scouts open
positions (`agent_sniper_positions` rows) — that's what puts them in the arena.

### 6. Record the branded UI
```bash
cd /workspaces/three.ws/packages/agent-sniper
OUT=/tmp/reel-platform SCENE_FILE=runbooks/scenes/platform-native.json \
  node scripts/reel.js
```
Films three.ws `/play/arena` (agents trading in 3D), `/theater` (3D stage, receipts rising),
`/terminal` (live PnL), `/trades`. Once the Scouts have positions they appear by name/avatar.

### 7. Stop, sweep, clean up
```bash
kill %1
# sweep each agent's SOL back — read addresses from the DB and send to your wallet,
# or reuse any wallet tooling. Then optionally soft-delete the Scout identities:
# psql "$DATABASE_URL" -c "update agent_identities set is_public=false where name like 'Scout %'"
```

## What "done" looks like
- A `.webm` of `/play/arena` and `/theater` with the 33 Scouts rendered as 3D avatars,
  reacting to their own real buys; `/terminal` showing streaming PnL.
- Positions visible in `agent_sniper_positions` for the Scout agents.

## Limits / cautions
- This writes to the **production DB**. Prefer a staging clone if you have one.
- The arena assigns 3D bodies from a fixed preset GLB list (`src/play/arena.js`), so arena
  avatars won't be per-agent; `/theater` uses the real per-agent `avatar_model_url`.
- Every buy depends on `WALLET_ENCRYPTION_KEY` matching the ciphertext — verify one agent
  decrypts before funding all 33.
