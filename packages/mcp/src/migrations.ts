/**
 * Directory of the SQL migrations for MCP tables (flexi_api_tokens,
 * mcp_audit_log). The CLI applies it as migration source "mcp".
 */
export const mcpMigrationsDir: URL = new URL("../migrations/", import.meta.url);
