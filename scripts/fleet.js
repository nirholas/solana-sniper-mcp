#!/usr/bin/env node
// fleet.js — throwaway-fleet test harness for @three-ws/agent-sniper.
//
// Stand up N self-custodial agent wallets, fund them from a single throwaway
// funder wallet, and run the real pump.fun sniper across them with a spread of
// strategy archetypes — so a small live run teaches you the *shape* of the
// parameter space, not one bot copied N times.
//
// Keys live OUTSIDE the repo (default ~/.three-ws-fleet/keys.json, chmod 600).
// They are throwaway by design — back that file up if you fund it, losing it
// loses the SOL. Secrets are NEVER printed or logged.
//
// Commands:
//   gen     [--n 33] [--dir <path>]              generate funder + N agent keypairs (no network)
//   plan    [--per <sol>]                        print the funding + strategy plan (no network)
//   balance --rpc <url>                          show funder + per-agent SOL balances
//   fund    --rpc <url> [--per <sol>] --yes      disburse SOL from funder → agents
//   sweep   --rpc <url> --to <addr> --yes        return all agent + funder SOL to one address
//   run     --rpc <url> [--mode simulate|live] [--yes]   arm strategies + start the sniper
//
// live mode moves REAL funds and must be opted into with --mode live --yes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
	Connection, Keypair, PublicKey, SystemProgram, Transaction,
	LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import {
	presets, createSniper, createMemoryStore, createSelfCustodyWallet,
	createPumpClient, createWeb3Executor, createPumpPortalFeed,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── tunables ──────────────────────────────────────────────────────────────────
const DEFAULTS = {
	n: 33,
	network: 'mainnet',
	perTradeSol: 0.002,            // the user's chosen buy size
	dailyBudgetSol: 0.02,          // 10 snipes/day/agent ceiling
	funderReserveSol: 0.03,        // kept in funder for the disbursement tx fees
	minPerAgentSol: 0.02,          // refuse to fund below this — not enough for fees+rent+a trade
	transfersPerTx: 8,             // batch agent funding to save fees
};

const SOL = LAMPORTS_PER_SOL;
const lamports = (sol) => Math.round(sol * SOL);
const solStr = (lam) => (Number(lam) / SOL).toFixed(6);

// ── strategy archetypes ─────────────────────────────────────────────────────
// Every archetype shares the chosen per-trade size and a mandatory stop-loss;
// they differ in exit discipline and entry filters so the fleet explores the
// space. Distributed round-robin across the N agents.
function archetypes(perTradeSol, dailyBudgetSol) {
	const base = {
		enabled: true,
		trigger: 'new_mint',
		network: DEFAULTS.network,
		per_trade_lamports: String(lamports(perTradeSol)),
		daily_budget_lamports: String(lamports(dailyBudgetSol)),
		max_concurrent_positions: 2,
		slippage_bps: 500,
		max_price_impact_pct: 10,
		stop_loss_pct: 30,          // REQUIRED by the engine
		take_profit_pct: 60,
		trailing_stop_pct: 20,
		max_hold_seconds: 1800,
		require_socials: true,
		max_creator_launches: 10,
		// OWNER RULE: only newer projects, market cap $10k–$100k. Enforced on EVERY
		// archetype — never buy dust or already-run coins. The feed enriches
		// market_cap_usd (SOL mcap × live price); the scorer rejects a mint whose
		// mcap is unknown or outside the band (mc_below_min / mc_above_max), so a
		// missing price fails CLOSED (skips the buy) rather than buying a rug.
		min_market_cap_usd: 10000,
		max_market_cap_usd: 100000,
		// OWNER RULE: take initials at 2×, hold a moon bag, never a 100% exit up.
		initials_out_multiple: 2,
		moonbag_min_pct: 15,
	};
	return [
		{ key: 'scalp',    ...base, take_profit_pct: 40, stop_loss_pct: 25, trailing_stop_pct: 15, max_hold_seconds: 600 },
		{ key: 'runner',   ...base, take_profit_pct: 120, stop_loss_pct: 30, trailing_stop_pct: 25, max_hold_seconds: 3600 },
		// 'degen' no longer drops socials or widens the creator filter — the owner's
		// rules apply to every archetype. It keeps only a slightly higher impact
		// tolerance for faster fills within the same 10k–100k, socials-required band.
		{ key: 'degen',    ...base, max_price_impact_pct: 15, take_profit_pct: 80, stop_loss_pct: 35 },
		{ key: 'strict',   ...base, max_creator_launches: 3, min_creator_graduated: 1, take_profit_pct: 60, stop_loss_pct: 20 },
		{ key: 'patient',  ...base, take_profit_pct: 50, stop_loss_pct: 20, max_hold_seconds: 2400 },
		{ key: 'momentum', ...base, take_profit_pct: 70, stop_loss_pct: 22, trailing_stop_pct: 18, max_hold_seconds: 1200 },
	];
}

function strategiesForFleet(keys, perTradeSol, dailyBudgetSol) {
	const arch = archetypes(perTradeSol, dailyBudgetSol);
	return keys.agents.map((a, i) => {
		const t = arch[i % arch.length];
		const { key, ...strat } = t;
		return { id: `strat_${a.id}`, agent_id: a.id, _archetype: key, ...strat };
	});
}

// ── keyfile ─────────────────────────────────────────────────────────────────
function keyPath(flags) {
	const dir = flags.dir || process.env.FLEET_DIR || path.join(os.homedir(), '.three-ws-fleet');
	return { dir, file: path.join(dir, 'keys.json') };
}

function loadKeys(flags) {
	const { file } = keyPath(flags);
	if (!fs.existsSync(file)) fail(`no keyfile at ${file} — run "gen" first`);
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function kpFromSecret(secret) { return Keypair.fromSecretKey(bs58.decode(secret)); }

// ── commands ────────────────────────────────────────────────────────────────
function cmdGen(flags) {
	const n = Number(flags.n || DEFAULTS.n);
	if (!Number.isInteger(n) || n < 1 || n > 500) fail(`--n must be 1..500, got ${flags.n}`);
	const { dir, file } = keyPath(flags);
	if (fs.existsSync(file) && !flags.force) {
		fail(`keyfile already exists at ${file} — refuse to overwrite (funds may be tied to it). Use --force to replace.`);
	}
	fs.mkdirSync(dir, { recursive: true });

	const funder = Keypair.generate();
	const agents = Array.from({ length: n }, (_, i) => {
		const kp = Keypair.generate();
		return { id: `scout${String(i + 1).padStart(2, '0')}`, address: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey) };
	});
	const data = {
		network: flags.network || DEFAULTS.network,
		note: 'THROWAWAY fleet keys for @three-ws/agent-sniper. Back this file up; losing it loses any SOL held.',
		funder: { address: funder.publicKey.toBase58(), secret: bs58.encode(funder.secretKey) },
		agents,
	};
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
	fs.chmodSync(file, 0o600);

	console.log(`\n  Generated ${n} agent wallets + 1 funder → ${file} (chmod 600)\n`);
	console.log(`  FUND THIS ADDRESS (funder):\n\n      ${funder.publicKey.toBase58()}\n`);
	console.log(`  Send your ${(3).toFixed(0)} SOL here, then:  node scripts/fleet.js fund --rpc <url> --yes\n`);
	console.log(`  Back up the keyfile now — it is the only copy of these throwaway keys.\n`);
}

function cmdPlan(flags) {
	const keys = loadKeys(flags);
	const perTrade = Number(flags['per-trade'] || DEFAULTS.perTradeSol);
	const daily = Number(flags['daily'] || DEFAULTS.dailyBudgetSol);
	const strategies = strategiesForFleet(keys, perTrade, daily);
	const counts = strategies.reduce((m, s) => (m[s._archetype] = (m[s._archetype] || 0) + 1, m), {});

	console.log(`\n  Fleet plan — ${keys.agents.length} agents on ${keys.network}\n`);
	console.log(`  Funder:            ${keys.funder.address}`);
	console.log(`  Per-trade size:    ${perTrade} SOL   (${lamports(perTrade)} lamports)`);
	console.log(`  Daily budget/agent:${daily} SOL   (${Math.round(daily / perTrade)} snipes/day/agent max)`);
	console.log(`  Fee headroom kept: ~0.012 SOL/wallet (engine guard) + ~0.002 SOL rent per open position\n`);
	console.log(`  Archetype spread:`);
	for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(10)} ${v} agents`);
	const perAgent = flags.per ? Number(flags.per) : null;
	if (perAgent) console.log(`\n  Funding: ${perAgent} SOL/agent → ${(perAgent * keys.agents.length).toFixed(3)} SOL total\n`);
	else console.log(`\n  Funding: auto — (funderBalance - ${DEFAULTS.funderReserveSol} reserve) / ${keys.agents.length}, rounded down\n`);
}

async function cmdBalance(flags) {
	const keys = loadKeys(flags);
	const conn = connection(flags);
	const funderLam = await conn.getBalance(new PublicKey(keys.funder.address));
	console.log(`\n  Funder ${keys.funder.address}  ${solStr(funderLam)} SOL\n`);
	let total = 0;
	const addrs = keys.agents.map((a) => new PublicKey(a.address));
	// getMultipleAccountsInfo in chunks of 100
	const infos = [];
	for (let i = 0; i < addrs.length; i += 100) {
		infos.push(...await conn.getMultipleAccountsInfo(addrs.slice(i, i + 100)));
	}
	keys.agents.forEach((a, i) => {
		const lam = infos[i]?.lamports || 0;
		total += lam;
		const bar = lam > 0 ? '●' : '·';
		console.log(`  ${bar} ${a.id}  ${a.address}  ${solStr(lam)} SOL  [${strategiesForFleet(keys, DEFAULTS.perTradeSol, DEFAULTS.dailyBudgetSol)[i]._archetype}]`);
	});
	console.log(`\n  Agents total: ${solStr(total)} SOL   Funder: ${solStr(funderLam)} SOL   Fleet: ${solStr(total + funderLam)} SOL\n`);
}

async function cmdFund(flags) {
	if (!flags.yes) fail('fund moves REAL SOL — re-run with --yes to confirm');
	const keys = loadKeys(flags);
	const conn = connection(flags);
	const funder = kpFromSecret(keys.funder.secret);
	const funderLam = await conn.getBalance(funder.publicKey);
	console.log(`\n  Funder balance: ${solStr(funderLam)} SOL`);

	const reserve = lamports(DEFAULTS.funderReserveSol);
	const distributable = funderLam - reserve;
	if (distributable <= 0) fail(`funder has ${solStr(funderLam)} SOL — below the ${DEFAULTS.funderReserveSol} SOL reserve. Fund the funder address first.`);

	let perAgentLam = flags.per ? lamports(Number(flags.per)) : Math.floor(distributable / keys.agents.length);
	if (perAgentLam < lamports(DEFAULTS.minPerAgentSol)) {
		fail(`per-agent would be ${solStr(perAgentLam)} SOL — below the ${DEFAULTS.minPerAgentSol} SOL minimum (fees+rent+a trade). Fund the funder with more SOL or lower --n.`);
	}
	console.log(`  Disbursing ${solStr(perAgentLam)} SOL to each of ${keys.agents.length} agents (${solStr(perAgentLam * keys.agents.length)} SOL total)\n`);

	// skip agents already at/above target (idempotent re-runs)
	const infos = [];
	const addrs = keys.agents.map((a) => new PublicKey(a.address));
	for (let i = 0; i < addrs.length; i += 100) infos.push(...await conn.getMultipleAccountsInfo(addrs.slice(i, i + 100)));
	const todo = keys.agents.filter((a, i) => (infos[i]?.lamports || 0) < perAgentLam);
	if (todo.length === 0) { console.log('  All agents already funded — nothing to do.\n'); return; }
	console.log(`  ${todo.length} agents need funding; ${keys.agents.length - todo.length} already funded.\n`);

	let sent = 0;
	for (let i = 0; i < todo.length; i += DEFAULTS.transfersPerTx) {
		const batch = todo.slice(i, i + DEFAULTS.transfersPerTx);
		const tx = new Transaction();
		for (const a of batch) {
			tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: new PublicKey(a.address), lamports: perAgentLam }));
		}
		const sig = await sendAndConfirmTransaction(conn, tx, [funder], { commitment: 'confirmed' });
		sent += batch.length;
		console.log(`  batch ${i / DEFAULTS.transfersPerTx + 1}: funded ${batch.map((a) => a.id).join(', ')}  (${sent}/${todo.length})  ${sig.slice(0, 12)}…`);
	}
	console.log(`\n  Done. ${sent} agents funded. Run:  node scripts/fleet.js run --rpc <url> --mode live --yes\n`);
}

async function cmdSweep(flags) {
	if (!flags.yes) fail('sweep moves REAL SOL — re-run with --yes to confirm');
	if (!flags.to) fail('--to <address> required (where to send recovered SOL)');
	const dest = new PublicKey(flags.to);
	const keys = loadKeys(flags);
	const conn = connection(flags);
	const FEE = 5000; // leave lamports for the tx fee
	let recovered = 0;
	for (const a of [...keys.agents, keys.funder]) {
		const kp = kpFromSecret(a.secret);
		const bal = await conn.getBalance(kp.publicKey);
		if (bal <= FEE) continue;
		const amt = bal - FEE;
		const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: amt }));
		try {
			const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
			recovered += amt;
			console.log(`  swept ${solStr(amt)} SOL from ${a.id || 'funder'}  ${sig.slice(0, 12)}…`);
		} catch (e) { console.log(`  ! ${a.id || 'funder'} sweep failed: ${e.message}`); }
	}
	console.log(`\n  Recovered ${solStr(recovered)} SOL → ${dest.toBase58()}\n`);
}

async function cmdRun(flags) {
	const keys = loadKeys(flags);
	const mode = flags.mode || 'simulate';
	if (mode !== 'simulate' && mode !== 'live') fail('--mode must be simulate|live');
	if (mode === 'live' && !flags.yes) fail('live mode trades REAL funds — re-run with --mode live --yes');
	const rpcUrl = flags.rpc || process.env.SOLANA_RPC_URL || null;
	if (mode === 'live' && !rpcUrl) fail('live mode requires --rpc <url> (public RPC is refused)');

	const perTrade = Number(flags['per-trade'] || DEFAULTS.perTradeSol);
	const daily = Number(flags['daily'] || DEFAULTS.dailyBudgetSol);
	const armed = strategiesForFleet(keys, perTrade, daily);
	const archetypeByAgent = Object.fromEntries(armed.map((s) => [s.agent_id, s._archetype]));
	const strategies = armed.map(({ _archetype, ...s }) => s);
	const secrets = Object.fromEntries(keys.agents.map((a) => [a.id, a.secret]));

	// Live Telegram tracker: a message per buy/sell + a periodic portfolio summary.
	// Enabled by --telegram or by TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID being present.
	const { createTelegramTracker } = await import('./telegram.js');
	const tg = createTelegramTracker({
		token: flags['telegram-token'] || process.env.TELEGRAM_BOT_TOKEN,
		chatId: flags['telegram-chat'] || process.env.TELEGRAM_CHAT_ID,
		network: keys.network,
		archetypeByAgent,
	});
	// Rule: no pump.fun Mayhem tokens — only normal launches. Reads each mint's
	// bonding curve (cached, shared across agents) and skips isMayhemMode tokens.
	// On by default; --allow-mayhem disables it.
	const { createMayhemFilter } = await import('../src/mayhem-filter.js');
	const mayhem = flags['allow-mayhem'] ? null
		: createMayhemFilter({ rpcUrl, strictOnUnknown: Boolean(flags['mayhem-strict']) });

	const hooks = {
		...(tg.enabled ? tg.hooks : {}),
		...(mayhem ? { oracleGate: mayhem.oracleGate } : {}),
	};

	console.log(`\n  Starting sniper — ${keys.agents.length} agents · ${mode.toUpperCase()} · ${keys.network} · ${perTrade} SOL/trade`);
	console.log(`  RPC: ${rpcUrl ? rpcUrl.replace(/api-key=[^&]+/i, 'api-key=***') : 'default'}`);
	console.log(`  Telegram tracker: ${tg.enabled ? 'ON' : 'off (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`);
	console.log(`  Mayhem filter: ${mayhem ? (flags['mayhem-strict'] ? 'ON (strict — skip on unknown)' : 'ON (skip Mayhem tokens)') : 'OFF (--allow-mayhem)'}\n`);

	// --serve mounts the package's own HTTP API + web console over THIS fleet's
	// live sniper/store, so packages/agent-sniper/web/console.html (and the
	// recorder's dashboard scene) shows our exact 33 agents, not a fresh engine.
	let sniper;
	if (flags.serve) {
		const port = Number(flags.port) || 8787;
		const store = createMemoryStore({ strategies });
		const solana = await createPumpClient({ network: keys.network, rpcUrl });
		sniper = createSniper({
			config: { network: keys.network, mode, rpcUrl },
			store,
			wallet: createSelfCustodyWallet({ secrets }),
			solana,
			executor: createWeb3Executor(),
			feed: createPumpPortalFeed({ network: keys.network }),
			hooks,
		});
		const { serve } = await import('../src/faces/api.js');
		await serve({ sniper, store, adminToken: process.env.SNIPER_ADMIN_TOKEN }, { port });
		sniper.__started = true; // serve() already called start()
		console.log(`  Console + API on http://localhost:${port}/  (film this)\n`);
		if (tg.enabled) tg.startSummary(sniper, store);
	} else {
		sniper = await presets.local({ network: keys.network, mode, rpcUrl, strategies, secrets, hooks });
		await sniper.start();
		if (tg.enabled) tg.startSummary(sniper, sniper.store || { listPositions: null });
	}
	if (tg.enabled) await tg.announce(`🚀 <b>Fleet armed</b> · ${keys.agents.length} agents · ${mode} · ${keys.network} · ${perTrade} SOL/trade`);

	const tick = setInterval(() => {
		const s = sniper.stats();
		const m = mayhem ? (() => { const c = mayhem.stats(); return ` mayhem_skipped=${c.mayhem} mayhem_unknown=${c.unknown}`; })() : '';
		console.log(`  [${new Date().toISOString().slice(11, 19)}] events=${s.events} candidates=${s.candidates} buys=${s.buys} sells=${s.sells} errors=${s.errors} queued=${s.queued}${m}`);
	}, 15_000);

	const stop = async () => {
		clearInterval(tick);
		console.log('\n  Stopping…');
		try { await sniper.stop?.(); } catch {}
		const s = sniper.stats();
		if (tg.enabled) {
			tg.stop();
			try { await tg.announce(`🛑 <b>Fleet stopped</b> · Buys ${s.buys} · Sells ${s.sells} · Errors ${s.errors}`); } catch {}
		}
		console.log('  Final stats:', JSON.stringify(s));
		process.exit(0);
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
	console.log('  Running. Ctrl-C to stop.\n');
}

// ── plumbing ────────────────────────────────────────────────────────────────
class CliError extends Error {}
function fail(msg) { throw new CliError(msg); }

function connection(flags) {
	let rpc = flags.rpc || process.env.SOLANA_RPC_URL;
	if (!rpc && process.env.HELIUS_API_KEY) rpc = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
	if (!rpc) fail('--rpc <url> required (or set SOLANA_RPC_URL / HELIUS_API_KEY)');
	return new Connection(rpc, 'confirmed');
}

function parseArgv(argv) {
	const flags = {}; let command = null;
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === '-h' || tok === '--help') { flags.help = true; continue; }
		if (tok.startsWith('--')) {
			const body = tok.slice(2); const eq = body.indexOf('=');
			if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
			const next = argv[i + 1];
			if (next != null && !next.startsWith('--')) { flags[body] = next; i++; } else flags[body] = true;
			continue;
		}
		if (command == null) command = tok;
	}
	return { command, flags };
}

const USAGE = `
fleet.js — throwaway sniper fleet

  gen     [--n 33] [--dir <path>] [--force]        generate funder + N agent keypairs
  plan    [--per <sol>]                            print funding + strategy plan
  balance --rpc <url>                              show funder + per-agent balances
  fund    --rpc <url> [--per <sol>] --yes          disburse SOL funder → agents
  run     --rpc <url> [--mode simulate|live] --yes arm strategies + start sniper
  sweep   --rpc <url> --to <addr> --yes            recover all SOL to one address

Keys default to ~/.three-ws-fleet/keys.json (chmod 600). live moves REAL funds.
`;

async function main() {
	const { command, flags } = parseArgv(process.argv.slice(2));
	if (flags.help || !command) { console.log(USAGE); return; }
	const cmds = { gen: cmdGen, plan: cmdPlan, balance: cmdBalance, fund: cmdFund, run: cmdRun, sweep: cmdSweep };
	const fn = cmds[command];
	if (!fn) fail(`unknown command "${command}" — see --help`);
	await fn(flags);
}

main().catch((e) => {
	if (e instanceof CliError) { console.error(`\n  ✗ ${e.message}\n`); process.exit(1); }
	console.error(e);
	process.exit(1);
});
