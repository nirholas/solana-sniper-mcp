# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`@three-ws/agent-sniper` v0.1.7. Lightweight, embeddable pump.fun sniper engine for 3D AI agents — multi-agent, multi-user, with pluggable wallet/store/RPC adapters. Library + CLI + MCP server + x402 paid API.

A Model Context Protocol server. Run it over stdio from any MCP client.

## Use it

```bash
npx -y @three-ws/agent-sniper
```

Full usage, tool list and configuration are in [README.md](README.md). Machine-readable summaries: [llms.txt](llms.txt) and [llms-full.txt](llms-full.txt).

## Develop

```bash
npm install
npm test
```

Scripts:
- `npm run start`: `node bin/agent-sniper.js run`
- `npm run mcp`: `node bin/agent-sniper.js mcp`
- `npm run serve`: `node bin/agent-sniper.js serve`
- `npm run test`: `vitest run`

## Conventions

- ES modules, Node >=20.
- Read-only by default. Anything that signs, spends or sends must be an explicit, separately named tool or option, and must never be inferred from untrusted text (token names, memos, listings).
- Never commit credentials. Configuration comes from environment variables documented in the README.
- Keep changes small and covered by a test next to the code they change.

## Source of truth

This repository is a generated mirror of `packages` in https://github.com/nirholas/three.ws. Open issues here; send substantial changes as a pull request here or upstream.
