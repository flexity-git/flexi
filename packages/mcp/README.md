# @flexity/mcp

Connect Claude to your Shoptet store. `flexi-mcp` is an MCP server that gives Claude Code,
Claude Desktop or any MCP client:

- **live Shoptet tools** that read the Shoptet Private API directly (orders, products, stores),
  with nothing to install but your API token;
- **scoped, read-only SQL** over the local Postgres mirror built by flexi modules, behind a
  parser-based guard, a read-only transaction and an audit log;
- **safe team access** over HTTP: every person or bot gets their own revocable token with
  exactly the scopes they need;
- one **write tool** (product visibility) that always previews first and only writes with a
  short-lived confirm token.

## Two-minute start (live tools only)

You need Node 20.19+, a clone of this repository with `npm install` done, and a Shoptet
Private API token (Shoptet admin, Connections, Private API).

```sh
FLEXI_STORES=main SHOPTET_TOKEN_MAIN=<your token> npx tsx packages/mcp/src/bin.ts --help
```

### Claude Code

```sh
claude mcp add flexi \
  --env FLEXI_STORES=main \
  --env SHOPTET_TOKEN_MAIN=<your token> \
  -- /absolute/path/to/flexi/node_modules/.bin/tsx /absolute/path/to/flexi/packages/mcp/src/bin.ts
```

Add `--scope user` to make it available in every project. Then ask Claude, for example,
"Which orders came in today in store main?"

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit config):

```json
{
  "mcpServers": {
    "flexi": {
      "command": "/absolute/path/to/flexi/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/flexi/packages/mcp/src/bin.ts"],
      "env": {
        "FLEXI_STORES": "main",
        "SHOPTET_TOKEN_MAIN": "<your token>",
        "FLEXI_MCP_SCOPES": "shoptet:read"
      }
    }
  }
}
```

The absolute `tsx` path avoids depending on the working directory Claude Desktop starts in.

## Tools

| Tool | Scope | Needs DB | What it does |
|---|---|---|---|
| `shoptet_stores` | `shoptet:read` | no | Store keys, primary store, URL; optional live e-shop name. Never tokens. |
| `shoptet_order_get` | `shoptet:read` | no | One order by code. Personal data only with `data:read:customers`. |
| `shoptet_orders_recent` | `shoptet:read` | no | Orders created since a date (default 24 h), optional status id, capped at 100, with a `truncated` flag. |
| `shoptet_product_get` | `shoptet:read` | no | One product by GUID or variant code, with variants, price, stock, availability. |
| `shoptet_product_search` | `shoptet:read` | no | Exact variant-code lookup plus accent-insensitive name scan over a capped number of list pages (`complete` flag). |
| `data_catalog` | `data:read` | yes | Allowlisted tables from installed modules, their scopes, and the caller's scopes. |
| `schema_describe` | `data:read` | yes | Columns of the tables the caller may read. |
| `query` | `data:read` (+ per table) | yes | One read-only SELECT with `$1` params, row and byte caps, `truncated` flag. |
| `shoptet_product_visibility_set` | `shoptet:write:products` | no | Preview, then confirm. Disabled unless `FLEXI_MCP_ENABLE_WRITES=true`. |

Tools the caller has no scope for are not listed at all.

All Shoptet responses are built from an allowlist of fields, so new or unexpected API fields
(purchase prices, IP addresses, internal remarks) never pass through by accident. Customer
name, e-mail, phone, addresses and customer remarks are included only for callers holding
`data:read:customers` (together with `data:read`).

## Scopes

| Scope | Grants |
|---|---|
| `data:read` | SQL tools; tables exposed with scope `data:read`. Required for every query. |
| `data:read:customers` | Extends `data:read`: tables with personal data, and personal fields in live order tools. Useless without `data:read`. |
| `shoptet:read` | Live read tools. |
| `shoptet:write:products` | The product visibility write tool (also needs `FLEXI_MCP_ENABLE_WRITES=true`). |
| `*` | Every read scope. Never grants a write scope; those must be listed by name. |

stdio mode takes its scopes from `FLEXI_MCP_SCOPES` (default `data:read,shoptet:read`).
HTTP mode takes them from the caller's token.

## Environment

| Variable | Meaning |
|---|---|
| `FLEXI_STORES`, `SHOPTET_TOKEN_<KEY>` | Stores and their Private API tokens (see the root docs). |
| `FLEXI_DATABASE_URL` | Postgres. Enables SQL tools, the audit table and HTTP tokens. Without it, audit lines go to stderr. |
| `FLEXI_MCP_SCOPES` | stdio caller scopes. Default `data:read,shoptet:read`. |
| `FLEXI_MCP_ENABLE_WRITES` | `true` to expose write tools. Default off. |
| `FLEXI_MCP_DATABASE_URL` | Login the query tools connect as: a dedicated reader with SELECT on `data:read` tables only (see `db-roles`). **Required in HTTP mode when SQL tools are enabled.** |
| `FLEXI_MCP_CUSTOMERS_DATABASE_URL` | Optional second reader login that may also read `data:read:customers` tables. Used only for callers holding that scope; without it, those callers use the plain reader and Postgres refuses customer tables. |
| `FLEXI_MCP_ALLOWED_HOSTS` | HTTP mode: host names accepted in `Host` and `Origin` (DNS-rebinding protection). Default `localhost,127.0.0.1,::1`. Set the public name when behind a proxy. |
| `FLEXI_MCP_QUERY_ROLE`, `FLEXI_MCP_CUSTOMERS_ROLE` | Optional extra: roles switched to with `SET LOCAL ROLE` inside each query transaction. Not a security boundary; the reader login is. |
| `FLEXI_MCP_CONFIRM_SECRET` | Optional HMAC secret (32+ characters) for confirm tokens. Default: random per process. |

flexi reads `FLEXI_DATABASE_URL`, never `DATABASE_URL`, so a variable exported for another
project can never make it connect to the wrong database.

## Database setup

The MCP tables (`flexi_api_tokens`, `mcp_audit_log`) are created by `flexi migrate`, which
applies `packages/mcp/migrations` as migration source `mcp`.

## SQL safety

The boundary is the database login. Everything else is defense in depth.

1. **Dedicated reader logins (primary boundary)**. Generate the SQL for your installed modules
   and run it as a user with `CREATEROLE`:

   ```sh
   npx tsx packages/mcp/src/bin.ts db-roles > mcp-roles.sql   # review, then: psql -f mcp-roles.sql
   ```

   It creates two LOGIN roles that are members of no other role:
   `flexi_mcp_reader` (SELECT on `data:read` tables only) and `flexi_mcp_reader_customers`
   (also the `data:read:customers` tables), each with `default_transaction_read_only`,
   `statement_timeout`, `idle_in_transaction_session_timeout`, `work_mem` and
   `temp_file_limit` set on the role. Set their passwords with `\password`, then point
   `FLEXI_MCP_DATABASE_URL` and `FLEXI_MCP_CUSTOMERS_DATABASE_URL` at them. Postgres then refuses
   tokens, the audit log and (for callers without `data:read:customers`) customer tables, even
   if the guard below had a gap. HTTP mode refuses to start SQL tools without
   `FLEXI_MCP_DATABASE_URL`. In stdio mode without it, queries run as the main flexi user and a
   warning is logged: acceptable for one local user, not for shared access. The query tools
   always use their own connection pool, separate from the one for tokens and the audit log.
   Re-run `db-roles` after installing or removing modules.
2. **Parser guard** (`pgsql-ast-parser`): comments, dollar quoting, backslashes and prefixed
   strings are rejected before parsing, so the parser and Postgres cannot read the text
   differently. Then exactly one statement; a fail-closed walk over **every** node of the syntax
   tree (any node type outside a fixed list, such as DML, DDL, row locking or WITH RECURSIVE, is
   rejected); WITH only at the top level, with non-recursive CTE scoping; CTE names must not
   equal a table name or be quoted mixed-case; tables must be in the catalogue and the caller
   must hold each table's scope; no schema other than `public`; no schema-qualified functions or
   casts to catalog types (`regclass`, ...); and **functions must be on a fixed allowlist** of
   plain scalar, aggregate and window functions. Functions such as `ts_stat`, `query_to_xml` or
   `xpath_table` take SQL as a string, and `generate_series` or `repeat` can produce unbounded
   output, so none of them are allowed.
3. **Execution**: `BEGIN`, `SET TRANSACTION READ ONLY`, `statement_timeout` 15 s, the extended
   protocol (the server itself refuses a second statement), the query wrapped as a subquery with
   a row limit, a 1 MB byte cap, and `ROLLBACK` at the end. Truncation sets `truncated: true`.
4. **Errors**: database and unexpected errors are never shown to the caller (Postgres error text
   can contain row values). The caller gets a generic message with a short reference; the
   redacted detail is in the audit log under that reference. Guard rejections are shown as is.

Tables come only from the `tables` manifests of installed modules. `flexi_api_tokens`,
`mcp_audit_log` and `flexi_migrations` can never be exposed.

## Audit log

Every tool call (including rejected and failed ones) is written to `mcp_audit_log`: token id,
tool, redacted arguments, SQL for `query`, row count, truncated flag, error (with the reference
shown to the caller) and duration. Arguments are redacted before they reach any writer: keys
that look like tokens, secrets, passwords or authorization headers become `[redacted]`. In
arguments, SQL and error text, e-mail addresses become `[email]`, flexi API tokens `[token]`,
bearer values `Bearer [redacted]` and long hex strings (such as token hashes) `[hex]`. Bearer
tokens and confirm tokens are never logged.

## Team access over HTTP

```sh
# once, after flexi migrate
npx tsx packages/mcp/src/bin.ts token create --name="Analyst laptop" --scopes=data:read,shoptet:read
npx tsx packages/mcp/src/bin.ts token list
npx tsx packages/mcp/src/bin.ts token revoke 3

# serve (binds 127.0.0.1 by default; put TLS in front, e.g. a reverse proxy).
# FLEXI_MCP_DATABASE_URL must log in as flexi_mcp_reader (see db-roles above).
FLEXI_MCP_ALLOWED_HOSTS=mcp.shop.example npx tsx packages/mcp/src/bin.ts --http --port=8787
```

The token is printed once; only its sha256 is stored. Clients connect to `POST /mcp` with
`Authorization: Bearer <token>`:

```sh
claude mcp add --transport http flexi https://mcp.shop.example/mcp \
  --header "Authorization: Bearer <token>"
```

The transport is stateless Streamable HTTP: each request is authenticated and served by a
server bound to that token's scopes. Requests whose `Host` or `Origin` is not in
`FLEXI_MCP_ALLOWED_HOSTS` get 403 (DNS-rebinding protection). `GET /healthz` answers without
auth.

## Write tools: preview, then confirm

`shoptet_product_visibility_set` (`store`, `guid`, `visibility`):

1. Call without `confirm_token`: returns the current and the new visibility and a
   `confirm_token`. Nothing changes.
2. Show the preview to a human.
3. Call again with the same parameters and the `confirm_token`. The token is an HMAC bound to
   the exact parameters, the previewed value and the caller; it expires after 10 minutes and
   works once. If the product changed since the preview, nothing is written. After the PATCH
   the tool re-reads the product and returns `applied`, or `unverified` when the read-back
   differs (treat that as not done).

## Commands

```
npx tsx packages/mcp/src/bin.ts            # stdio (default)
npx tsx packages/mcp/src/bin.ts --http [--port=8787] [--host=127.0.0.1]
npx tsx packages/mcp/src/bin.ts token create --name=<name> --scopes=<list>
npx tsx packages/mcp/src/bin.ts token list
npx tsx packages/mcp/src/bin.ts token revoke <id>
npx tsx packages/mcp/src/bin.ts db-roles [--reader=<role>] [--customers=<role>]
```

When installed as a package the same commands are available as `flexi-mcp`.

## Known limits

- `shoptet_product_search` scans product list pages for name matches because the Shoptet
  product list is not used with a name filter here; for large catalogues use the mirror via
  `query`.
- `shoptet_orders_recent` returns the first orders the API lists for the window; when
  `truncated` is true, narrow `since`.
- The SQL parser does not support `INTERSECT`, `EXCEPT` or `WITH RECURSIVE`.

Shoptet endpoint details: https://developers.shoptet.com/
