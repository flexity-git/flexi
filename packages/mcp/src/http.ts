import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "@flexity/core";
import type { Queryable } from "./db-types.js";
import { createMcpServer } from "./server.js";
import { resolveToken, type ResolvedToken } from "./tokens.js";
import type { Caller, ServerDeps } from "./tools.js";

export const MAX_BODY_BYTES = 1_000_000;

export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"];

export interface HttpOptions {
  port: number;
  host: string;
  log: Logger;
  /**
   * Host names accepted in the Host and Origin headers (DNS-rebinding
   * protection). Default: localhost only. Set FLEXI_MCP_ALLOWED_HOSTS to the
   * public name when serving behind a reverse proxy.
   */
  allowedHosts?: string[];
  /** Resolves a bearer value. Defaults to the flexi_api_tokens table. */
  resolve?: (token: string) => Promise<ResolvedToken | null>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large."), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON."), { status: 400 });
  }
}

export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

/**
 * Streamable HTTP transport, stateless: every POST /mcp is authenticated with
 * a bearer token and served by a fresh MCP server bound to that token's scopes.
 */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Host and Origin must name an allowed host. A missing Origin (non-browser client) is fine. */
export function hostAllowed(headers: { host?: string | undefined; origin?: string | undefined }, allowed: readonly string[]): boolean {
  const set = new Set(allowed.map((h) => h.toLowerCase().replace(/^\[|\]$/g, "")));
  const host = headers.host ? hostnameOf(headers.host) : null;
  if (!host || !set.has(host)) return false;
  if (headers.origin !== undefined) {
    const origin = hostnameOf(headers.origin);
    if (!origin || !set.has(origin)) return false;
  }
  return true;
}

export function createHttpHandler(deps: ServerDeps, options: Pick<HttpOptions, "log" | "resolve" | "allowedHosts">) {
  const allowedHosts = options.allowedHosts && options.allowedHosts.length > 0 ? options.allowedHosts : DEFAULT_ALLOWED_HOSTS;
  const resolve =
    options.resolve ??
    ((token: string) => {
      if (!deps.db) throw new Error("HTTP mode needs FLEXI_DATABASE_URL for API tokens.");
      return resolveToken(deps.db as Queryable, token);
    });

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!hostAllowed({ host: req.headers.host, origin }, allowedHosts)) {
      return sendJson(res, 403, { error: "Host or Origin not allowed. Add it to FLEXI_MCP_ALLOWED_HOSTS." });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") return sendJson(res, 200, { ok: true });
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST /mcp (stateless Streamable HTTP)." }, { Allow: "POST" });

    const bearer = bearerOf(req);
    const token = bearer ? await resolve(bearer).catch(() => null) : null;
    if (!token) {
      return sendJson(res, 401, { error: "Missing or invalid bearer token." }, { "WWW-Authenticate": 'Bearer realm="flexi-mcp"' });
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return sendJson(res, status, { error: err instanceof Error ? err.message : "Bad request." });
    }

    const caller: Caller = { tokenId: token.id, id: `token:${token.id}`, scopes: token.scopes };
    const server = createMcpServer(deps, caller);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      options.log.error("mcp http request failed", { reason: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
    }
  };
}

export function startHttpServer(deps: ServerDeps, options: HttpOptions): Promise<HttpServer> {
  if (!deps.db && !options.resolve) {
    throw new Error("HTTP mode needs FLEXI_DATABASE_URL: API tokens and the audit log live in the database.");
  }
  const handler = createHttpHandler(deps, options);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      options.log.error("mcp http handler crashed", { reason: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      options.log.info("flexi-mcp listening", { url: `http://${options.host}:${options.port}/mcp` });
      resolvePromise(server);
    });
  });
}
