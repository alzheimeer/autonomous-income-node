# GitHub Copilot Instructions — Autonomous Income Node

Read `CLAUDE.md` for full project context.

## Quick Reference
- Node.js 20 + TypeScript strict ESM (NodeNext)
- USDC amounts always as `bigint` with 6 decimals ($1 = 1_000000n)
- All `.ts` imports need `.js` extension
- MCP pattern for external tools (`src/mcp/servers/`)
- ReAct loop: Think(LLM)→Act(modules)→Observe(SQLite)
- 5 survival tiers: EMERGENCY/TIER_1-4 based on USDC balance
- Never log secrets — use maskSecrets() from config/log-filter.ts
- 3 Docker containers: ain-agent, ain-research, ain-redis
- Domain: niklauss.uk (Cloudflare Tunnel)
- FeatureEngine: multi-pair technical indicators (EMA, RSI, MACD, ATR, BB, regime)
- ModelRouter: Haiku triage before expensive Sonnet calls
- KillSwitch: $5/day max loss, $15 total drawdown
- Hyperliquid: EIP-712 signing implemented (ethers signTypedData)
- RPC: Alchemy primary + Base public RPC fallback
