import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { redactArgs } from "./audit.js";
import { ConfirmTokenError } from "./confirm.js";
import { newErrorRef, publicErrorMessage, ToolError } from "./errors.js";
import { SqlRejected } from "./sql-guard.js";
import { hasScope } from "./scopes.js";
import { inputSchemaOf, TOOLS, type AuditExtra, type Caller, type ServerDeps, type ToolDefinition } from "./tools.js";

export const SERVER_NAME = "flexi";
export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = [
  "flexi connects you to one or more Shoptet stores.",
  "Start with shoptet_stores to learn the store keys; every Shoptet tool takes `store`.",
  "Live shoptet_* tools read the Shoptet API now. SQL tools (data_catalog, schema_describe, query) read a local mirror that is only as fresh as its last sync.",
  "For SQL: data_catalog first, then schema_describe, then query with $1 params. If `truncated` is true, do not draw conclusions; aggregate in SQL.",
  "Write tools are two-step: call without confirm_token for a preview, show it to a human, and only after approval call again with the token.",
  "If a tool is missing from the list, the caller lacks its scope or writes are disabled; it is not an error.",
].join("\n");

/** Tools this caller can see: available in this deployment and covered by the caller's scopes. */
export function visibleTools(deps: ServerDeps, caller: Caller): ToolDefinition[] {
  return TOOLS.filter((t) => t.available(deps) && hasScope(caller.scopes, t.scope));
}

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function text(value: unknown, isError = false): ToolCallResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Errors written for the caller that never carry database or API data. */
function isCallerSafe(err: unknown): boolean {
  return err instanceof SqlRejected || err instanceof ToolError || err instanceof ConfirmTokenError;
}

/** Runs one tool call with scope check, input validation and audit. Never throws. */
export async function callTool(deps: ServerDeps, caller: Caller, name: string, rawArgs: unknown): Promise<ToolCallResult> {
  const started = performance.now();
  const audit: AuditExtra = {};
  const args = rawArgs ?? {};
  let error: string | null = null;
  try {
    const tool = visibleTools(deps, caller).find((t) => t.name === name);
    if (!tool) {
      error = `Unknown tool "${name}", or the caller lacks its scope.`;
      return text(error, true);
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      error = `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
      return text(error, true);
    }
    const result = await tool.run(parsed.data, { deps, caller, audit });
    return text(result);
  } catch (err) {
    const ref = newErrorRef();
    // The full message goes to the audit log only (redacted by the writer).
    error = `[ref ${ref}] ${err instanceof Error ? err.message : String(err)}`;
    return text(publicErrorMessage(err, ref, isCallerSafe), true);
  } finally {
    await deps.audit({
      tokenId: caller.tokenId,
      tool: name,
      // Redacted here already, so no audit writer can ever see a raw secret.
      args: redactArgs(args),
      sql: audit.sql ?? null,
      rowCount: audit.rowCount ?? null,
      truncated: audit.truncated ?? false,
      error,
      durationMs: performance.now() - started,
    });
  }
}

/** A low-level MCP server bound to one caller. HTTP mode creates one per request. */
export function createMcpServer(deps: ServerDeps, caller: Caller): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools(deps, caller).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputSchemaOf(t),
      annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, openWorldHint: true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(deps, caller, req.params.name, req.params.arguments));
  return server;
}
