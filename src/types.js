// agent-sniper — adapter contracts (JSDoc typedefs, no runtime code).
//
// The engine is pure orchestration over four pluggable adapters. Implement these
// shapes and the same trade loop runs against any wallet custody model, any
// persistence backend, any RPC, and any launch feed. Default implementations
// for every one live under src/adapters/.
//
//   Store     — persistence: strategies, positions, spend ledger.
//   Wallet    — resolve a signing Keypair for an agentId.
//   Solana    — quote/build pump.fun buy & sell instructions + an RPC connection.
//   Executor  — sign + broadcast instructions, return landing telemetry.
//   Feed      — stream new-mint / trigger events.
//   Hooks     — optional cross-cutting callbacks (firewall, notify, screen, ledger).

/**
 * A strategy is the per-agent policy the engine evaluates every candidate
 * against. Mirrors the three.ws `agent_sniper_strategies` row so a Postgres
 * store can map 1:1, but no field here is three.ws-specific.
 *
 * @typedef {object} Strategy
 * @property {string} id                       stable strategy id
 * @property {string} agent_id                 owning agent (1 wallet per agent)
 * @property {string} [user_id]                owner (audit only)
 * @property {string} [agent_name]
 * @property {boolean} enabled                 must be true to arm
 * @property {boolean} [kill_switch]           emergency per-agent halt
 * @property {'new_mint'|'intel_confirmed'|'first_claim'|'manual'} [trigger]
 * @property {'mainnet'|'devnet'} [network]
 * @property {string|number|bigint} daily_budget_lamports   SOL/day ceiling
 * @property {string|number|bigint} per_trade_lamports      SOL per snipe
 * @property {number} [max_concurrent_positions]
 * @property {number} [slippage_bps]           default 500
 * @property {number} [max_price_impact_pct]   entry circuit breaker, default 10
 * @property {'off'|'economy'|'turbo'} [mev_tip_mode]
 * @property {'block'|'warn'|'off'} [firewall_level]
 * @property {number} [min_market_cap_usd]
 * @property {number} [max_market_cap_usd]
 * @property {number} [min_creator_graduated]
 * @property {number} [max_creator_launches]
 * @property {boolean} [require_socials]
 * @property {boolean} [require_sol_quote]     default true
 * @property {number} [take_profit_pct]
 * @property {number} [stop_loss_pct]          MANDATORY (engine enforces non-null)
 * @property {number} [trailing_stop_pct]
 * @property {number} [max_hold_seconds]       default 1800
 * @property {number} [min_quality_score]      intel trigger
 * @property {number} [max_bundle_score]       intel trigger
 * @property {number} [max_concentration_top1] intel trigger
 * @property {boolean} [avoid_dev_dump]        intel trigger, default true
 * @property {string[]} [allowed_categories]
 * @property {string} [telegram_chat_id]
 */

/**
 * An enriched candidate event from a Feed. `mint` is the only required field.
 * @typedef {object} Candidate
 * @property {string} mint
 * @property {string} [symbol]
 * @property {string} [name]
 * @property {number} [market_cap_usd]
 * @property {boolean} [is_usdc_pair]
 * @property {number} [creator_launches]
 * @property {number} [creator_graduated]
 * @property {string} [twitter]
 * @property {string} [telegram]
 * @property {string} [website]
 * @property {number} [initial_buy_sol]
 * @property {string} [entry_trigger]
 * @property {string} [trigger_ref]
 * @property {object} [signals]                intel-trigger signal bag
 * @property {number} [quality_score]
 * @property {string} [category]
 * @property {string[]} [risk_flags]
 */

/**
 * @typedef {object} Position
 * @property {string} id
 * @property {string} strategy_id
 * @property {string} agent_id
 * @property {string} [user_id]
 * @property {string} wallet
 * @property {'mainnet'|'devnet'} network
 * @property {string} mint
 * @property {string} [symbol]
 * @property {'opening'|'open'|'closing'|'closed'|'failed'} status
 * @property {string|number|bigint} [entry_quote_lamports]
 * @property {string|number|bigint} [base_amount]
 * @property {number} [peak_value_lamports]
 * @property {number} [last_value_lamports]
 * @property {number} [slippage_bps]
 * @property {number} [take_profit_pct]
 * @property {number} [stop_loss_pct]
 * @property {number} [trailing_stop_pct]
 * @property {number} [max_hold_seconds]
 * @property {number} [opened_at_ms]
 * @property {boolean} [kill_switch]
 * @property {string} [error]
 */

/**
 * Store — persistence boundary. All methods async. A backend that can't satisfy
 * `claimPosition` atomically (insert-if-absent on agent+mint+network) MUST
 * serialize per agent some other way, or duplicate buys become possible.
 *
 * @typedef {object} Store
 * @property {(network: string) => Promise<Strategy[]>} getArmedStrategies
 *   Return every enabled, non-kill-switched strategy for the network.
 * @property {(agentId: string, network: string) => Promise<number>} countOpenPositions
 * @property {(agentId: string, network: string) => Promise<bigint>} getDailySpendLamports
 *   Sum of today's committed snipe spend (lamports) for the agent.
 * @property {(p: { strategy: Strategy, candidate: Candidate, network: string }) => Promise<Position|null>} claimPosition
 *   Atomically reserve the (agent_id, mint, network) slot. Return the new
 *   Position row, or null if the slot is already held (→ skip, no double buy).
 * @property {(id: string, patch: Partial<Position>) => Promise<void>} updatePosition
 * @property {(network: string) => Promise<Position[]>} getOpenPositions
 *   Positions in status 'open' (and 'opening' older than a grace window).
 * @property {(e: SpendEvent) => Promise<void>} [recordSpend]
 *   Optional audit/ledger write. Absent ⇒ no-op.
 */

/**
 * @typedef {object} SpendEvent
 * @property {string} agentId
 * @property {string} [userId]
 * @property {'snipe'|'mev_tip'} category
 * @property {string} network
 * @property {bigint} amountLamports
 * @property {string|null} [signature]
 * @property {string} [mint]
 * @property {'ok'|'confirmed'} status
 */

/**
 * Wallet — resolve a signing Keypair for an agent. Self-custody returns a local
 * keypair; a custodial adapter decrypts on demand. Return null if the agent has
 * no provisioned wallet (the engine then fails the trade cleanly, never auto-
 * provisions an unfunded wallet).
 *
 * @typedef {object} Wallet
 * @property {(agentId: string, ctx?: { userId?: string, reason?: string }) =>
 *   Promise<{ keypair: import('@solana/web3.js').Keypair, address: string }|null>} loadKeypair
 */

/**
 * Solana — pump.fun trade primitives + a web3 Connection. The default impl
 * (adapters/solana/pump-client.js) is built on @pump-fun/pump-sdk; swap it to
 * route quotes/builds through any venue.
 *
 * ── Contract for a PumpSwap (post-graduation) adapter ────────────────────────
 * The default adapter prices the pump program's bonding curve. If you implement
 * one that routes through the PumpSwap AMM (@pump-fun/pump-swap-sdk >= 1.19.0),
 * quotes must price against the pool's EFFECTIVE quote reserve:
 *
 *     effective_quote_reserves = pool_quote_token_account.amount
 *                              + pool.virtual_quote_reserves
 *
 * `pool.virtual_quote_reserves` is an appended Pool field carrying a non-zero
 * value on launchpad coins from 2026-07-20; it is 0 elsewhere, where effective
 * equals the vault balance and nothing changes. The base side is unchanged:
 * still the raw pool_base_token_account.amount.
 *
 * Three ways to get this wrong, all of which produce bad numbers rather than an
 * error, so mind them:
 *
 *   1. Double-counting. The SDK's standalone quote functions (buyQuoteInput /
 *      sellBaseInput) take `virtualQuoteReserves` as its OWN argument and do the
 *      addition internally. Pass the RAW vault balance as `quoteReserve`
 *      alongside it. Passing an already-summed reserve prices the trade against
 *      double the virtual liquidity. The SDK's instance methods
 *      (PumpAmmSdk#buyQuoteInput) read the field off the swap state themselves
 *      and need nothing extra.
 *   2. Silently defaulting to 0. That argument defaults to 0, so omitting it
 *      prices off the raw vault balance with no error and no warning. Your own
 *      spot-price / price-impact / market-cap math must use the effective figure
 *      directly.
 *   3. Failing a tradable pool as empty. A liquidity gate must judge depth on
 *      the effective reserve; a launchpad pool can hold real quote-side depth
 *      virtually and reads as an empty pool on the vault balance alone.
 *
 * Do not confuse `Pool.virtual_quote_reserves` (post-graduation, the new field
 * above) with `BondingCurve.virtual_quote_reserves` (pre-graduation, the field
 * formerly spelled `virtual_sol_reserves`). Same name, different accounts,
 * different quantities; a coin has one or the other, never both.
 *
 * Whatever the venue: return a real `priceImpactPct` and a real `quoteMint`, or
 * throw. Never substitute 0 or an assumed wSOL: the entry breaker and the
 * require_sol_quote gate both read as PASS on a missing value.
 *
 * @typedef {object} SolanaClient
 * @property {import('@solana/web3.js').Connection} connection
 * @property {(p: BuyQuoteReq) => Promise<TradeQuote>} quoteForBuy
 * @property {(p: BuyBuildReq) => Promise<BuiltTrade>} buildBuyInstructions
 * @property {(p: SellReq) => Promise<TradeQuote>} quoteForSell
 * @property {(p: SellReq & { user: import('@solana/web3.js').PublicKey }) => Promise<BuiltTrade>} buildSellInstructions
 */

/**
 * @typedef {object} BuyQuoteReq
 * @property {import('@solana/web3.js').PublicKey} mint
 * @property {bigint} quoteLamports
 * @property {number} slippagePct
 *
 * @typedef {BuyQuoteReq & { user: import('@solana/web3.js').PublicKey }} BuyBuildReq
 *
 * @typedef {object} SellReq
 * @property {import('@solana/web3.js').PublicKey} mint
 * @property {bigint} baseAmount
 * @property {number} slippagePct
 *
 * @typedef {object} TradeQuote
 * @property {number} priceImpactPct          must be finite; throw rather than report 0 for "unknown"
 * @property {bigint} [expectedQuoteOut]      sell quotes; must be > 0n, never 0 for "unpriced"
 * @property {import('@solana/web3.js').PublicKey} [quoteMint]
 * @property {bigint} [quoteReserve]          AMM adapters: raw pool_quote_token_account.amount
 * @property {bigint} [virtualQuoteReserves]  AMM adapters: pool.virtual_quote_reserves
 * @property {bigint} [effectiveQuoteReserve] AMM adapters: quoteReserve + virtualQuoteReserves,
 *   the figure the quote was actually priced against. Report all three when the
 *   venue exposes them so a caller can reproduce the number; omit all three on a
 *   bonding-curve venue, which has no pool.
 *
 * @typedef {object} BuiltTrade
 * @property {import('@solana/web3.js').TransactionInstruction[]} instructions
 * @property {bigint} [expectedBaseTokens]    buy builds
 * @property {bigint} [expectedQuoteOut]      sell builds
 */

/**
 * Executor — the one place that signs and broadcasts. Return landing telemetry.
 * In simulate mode the engine never calls this (sig = 'SIMULATED').
 *
 * @typedef {object} Executor
 * @property {(p: SubmitReq) => Promise<ExecResult>} submit
 *
 * @typedef {object} SubmitReq
 * @property {string} network
 * @property {import('@solana/web3.js').Connection} connection
 * @property {import('@solana/web3.js').Keypair} payer
 * @property {import('@solana/web3.js').TransactionInstruction[]} instructions
 * @property {number} confirmTimeoutMs
 * @property {'off'|'economy'|'turbo'} [tipMode]
 * @property {(tipLamports: bigint, route: string) => Promise<void>} [onTip]
 *   Spend-guard veto hook: throw to cancel the tip (engine falls back to the
 *   untipped route). Called BEFORE a tip leaves the wallet.
 *
 * @typedef {object} ExecResult
 * @property {string} signature
 * @property {number} [slot]
 * @property {string} route                   'standard' | 'jito' | 'simulated'
 * @property {bigint} [tipLamports]
 * @property {number|null} [priorityFeeMicroLamports]
 * @property {number} [attempts]
 * @property {number|null} [landedMs]
 * @property {string|null} [fallbackReason]
 */

/**
 * Feed — push trigger events into the engine. `start` receives a callback and
 * returns a stop function. Emit `{ kind: 'mint'|'intel'|'claim', data: Candidate }`.
 *
 * @typedef {object} Feed
 * @property {(onEvent: (e: { kind: string, data: Candidate }) => void) => Promise<() => void>} start
 */

/**
 * Hooks — optional cross-cutting callbacks. Every one is best-effort: a throw or
 * rejection is swallowed and never aborts a trade (except `onTip`, which is a
 * deliberate veto). Omit any you don't need.
 *
 * @typedef {object} Hooks
 * @property {(p: object) => Promise<{ verdict: 'allow'|'warn'|'block', score: number, reasons?: string[] }|null>} [assessSafety]
 *   Rug/honeypot firewall, run after the quote and before broadcast.
 * @property {(p: { agentId: string, candidate: Candidate, network: string, strategy: Strategy }) => Promise<{ pass: boolean, reason?: string, skipped?: boolean }>} [oracleGate]
 * @property {(p: object) => void} [onScreen]      live-visualization push (3D desk / web view)
 * @property {(p: object) => void} [onBuy]
 * @property {(p: object) => void} [onSell]
 * @property {(p: object) => Promise<void>} [recordDecision]   tamper-evident ledger
 */

export {};
