/**
 * Lift the MCP rate limit for the suite: integration tests make many calls on
 * one token in quick succession. `tests/mcp-rate-limit.test.ts` sets real
 * numbers itself through `mcpBuckets.configure`.
 */
process.env.MCP_RATE_LIMIT_PER_MIN ??= "1000000000";
process.env.MCP_RATE_LIMIT_BURST ??= "1000000000";
