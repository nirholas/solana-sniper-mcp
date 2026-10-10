// agent-sniper — minimal structured logger.
//
// Zero-dependency. Emits one JSON line per event to stderr so stdout stays
// clean for MCP stdio transport. A consumer can swap this for their own logger
// by passing `{ logger }` into createSniper(); every module imports `log` from
// here only as the default.

function emit(level, msg, fields) {
	const line = { t: new Date().toISOString(), level, msg, ...(fields || {}) };
	try {
		process.stderr.write(`${JSON.stringify(line)}\n`);
	} catch {
		// stderr closed (rare) — drop the line rather than crash the trader.
	}
}

export const log = {
	debug: (msg, fields) => { if (process.env.SNIPER_DEBUG) emit('debug', msg, fields); },
	info: (msg, fields) => emit('info', msg, fields),
	warn: (msg, fields) => emit('warn', msg, fields),
	error: (msg, fields) => emit('error', msg, fields),
	// `trade` is a distinct channel so fills are greppable and never debug-gated.
	trade: (msg, fields) => emit('trade', msg, fields),
};

export default log;
