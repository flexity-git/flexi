import { parse, type Statement } from "pgsql-ast-parser";
import type { CatalogTable } from "./catalog.js";
import { hasScope } from "./scopes.js";

/**
 * SQL guard: parses the query and rejects anything that is not a single
 * read-only SELECT over allowlisted tables the caller has scopes for.
 *
 * It is one layer. The query also runs inside a READ ONLY transaction with a
 * statement timeout, and the README recommends a database role that can only
 * SELECT the allowlisted tables. A gap here must not mean full access.
 *
 * Why a parser instead of string rules: a table can hide in a CTE, a
 * subquery, a JOIN or a UNION branch, and comments can split keywords.
 */

export const MAX_SQL_LENGTH = 10_000;

/**
 * Lexical pre-check. The parser and Postgres must read the same text the same
 * way, or a table can hide in what the parser thinks is a comment or a string
 * while Postgres executes it (nested block comments, dollar quoting, backslash
 * escapes, E'' and U&'' strings). Instead of modelling every lexer rule, the
 * constructs where the two can disagree are rejected outright. Plain '...'
 * strings with doubled quotes, "..." identifiers and $1 params stay allowed.
 */
export function assertLexicallySafe(sql: string): void {
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      const prev = i > 0 ? sql[i - 1]! : "";
      if (/[A-Za-z0-9_&$]/.test(prev)) {
        throw new SqlRejected("String prefixes (E'', U&'', B'', X'') are not allowed. Use a plain '...' string or a $1 param.");
      }
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new SqlRejected("The query has an unterminated quote.");
        const c = sql[j]!;
        if (c === "\\") throw new SqlRejected("Backslashes are not allowed in strings or identifiers. Pass the value as a $1 param.");
        if (c === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if ((ch === "-" && next === "-") || (ch === "/" && next === "*")) {
      throw new SqlRejected("Comments are not allowed in queries.");
    }
    if (ch === "$" && !(next !== undefined && /[0-9]/.test(next))) {
      throw new SqlRejected("Dollar quoting is not allowed. Use a plain '...' string or a $1 param.");
    }
    if (ch === "\\") throw new SqlRejected("Backslashes are not allowed in queries.");
  }
}

/**
 * Function ALLOWLIST. Anything not listed is rejected, because some Postgres
 * functions run a query passed as a string (ts_stat, ts_rewrite, the
 * query_to_xml family, xpath_table, dblink, ...) and would read tables the
 * parser never sees. A denylist cannot keep up with that; an allowlist can.
 * Only plain scalar, aggregate and window functions belong here. Never add a
 * function that takes SQL text, reads files, touches settings or catalogs, or
 * can produce unbounded output from a small input (generate_series, repeat,
 * lpad, rpad).
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // SQL constructs the parser reports as calls
  "exists", "any", "all", "position",
  // aggregates
  "count", "sum", "avg", "min", "max", "bool_and", "bool_or", "every", "string_agg", "array_agg",
  "json_agg", "jsonb_agg", "json_object_agg", "jsonb_object_agg", "stddev", "stddev_pop", "stddev_samp",
  "variance", "var_pop", "var_samp", "percentile_cont", "percentile_disc", "mode", "corr",
  // window
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value",
  // conditional
  "coalesce", "nullif", "greatest", "least",
  // math
  "abs", "round", "ceil", "ceiling", "floor", "trunc", "mod", "power", "sqrt", "sign", "div", "exp", "ln", "log",
  // text
  "lower", "upper", "initcap", "trim", "btrim", "ltrim", "rtrim", "length", "char_length", "character_length",
  "octet_length", "substring", "substr", "left", "right", "strpos", "replace", "translate", "concat",
  "concat_ws", "split_part", "reverse", "starts_with", "regexp_replace",
  "regexp_match", "regexp_matches", "regexp_split_to_array", "md5",
  // date and time
  "now", "date_trunc", "date_part", "extract", "age", "to_char", "to_date", "to_timestamp", "to_number",
  "make_date", "make_interval", "make_timestamp", "make_timestamptz", "timezone", "justify_days",
  "justify_hours", "date_bin", "isfinite",
  // json
  "to_json", "to_jsonb", "json_build_object", "jsonb_build_object", "json_build_array", "jsonb_build_array",
  "json_extract_path", "json_extract_path_text", "jsonb_extract_path", "jsonb_extract_path_text",
  "json_array_length", "jsonb_array_length", "json_array_elements", "jsonb_array_elements",
  "json_array_elements_text", "jsonb_array_elements_text", "json_each", "jsonb_each", "json_each_text",
  "jsonb_each_text", "json_object_keys", "jsonb_object_keys", "json_typeof", "jsonb_typeof", "jsonb_strip_nulls",
  // arrays
  "array_length", "cardinality", "unnest", "array_to_string", "string_to_array", "array_position",
  "array_remove", "array_append", "array_cat",
]);

/** Rejected query. The message is shown to the caller, so it says what to change. */
export class SqlRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlRejected";
  }
}

export interface GuardResult {
  /** Real tables the query reads, sorted. */
  tables: string[];
}

interface TableRefName {
  name: string;
  schema?: string;
}

function isFunctionAllowed(name: string): boolean {
  // Exact match: a quoted mixed-case name is a different function in Postgres.
  return ALLOWED_FUNCTIONS.has(name);
}

/**
 * AST node `type` values a read-only query may contain. Anything else fails
 * closed: DML and DDL statements, locking clauses (`for: {type: "update"}`),
 * WITH RECURSIVE and any node type a future parser version adds.
 */
const ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  // statements
  "select", "union", "union all", "values", "with",
  // FROM items
  "table", "statement", "call",
  "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN",
  // expressions
  "ref", "parameter", "list", "array", "array select", "null", "extract", "integer", "numeric", "string",
  "boolean", "constant", "keyword", "member", "arrayIndex", "binary", "unary", "ternary", "case", "cast",
  "substring", "overlay",
]);

/** Type names a cast must not target: catalog lookups (regclass, ...) and schema-qualified types. */
function assertCastTarget(to: unknown): void {
  const t = to as { name?: unknown; schema?: unknown } | null;
  if (!t || typeof t !== "object") return;
  if (t.schema !== undefined) throw new SqlRejected("Casts to schema-qualified types are not allowed.");
  const name = typeof t.name === "string" ? t.name.toLowerCase() : "";
  if (name.startsWith("reg") || name.startsWith("pg_")) throw new SqlRejected(`Casts to ${name} are not allowed.`);
}

const MAX_AST_DEPTH = 200;

interface Collected {
  tables: TableRefName[];
  functions: { name: string; schema?: string }[];
}

/**
 * Generic, fail-closed walk over EVERY property of the AST. It does not rely
 * on the parser's visitor, which skips some positions (DISTINCT ON, window
 * PARTITION BY / ORDER BY, JOIN ... ON of a function FROM item). Every object
 * with a `type` must have an allowlisted type; every `call` node and every
 * `table` FROM item is collected wherever it appears.
 */
function walk(node: unknown, out: Collected, isRoot: boolean, depth = 0): void {
  if (depth > MAX_AST_DEPTH) throw new SqlRejected("The query is too deeply nested. Simplify it.");
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out, false, depth + 1);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if ("type" in obj) {
    const type = obj.type;
    if (typeof type !== "string" || !ALLOWED_NODE_TYPES.has(type)) {
      throw new SqlRejected(
        `Query construct "${String(type)}" is not allowed. Only read-only SELECT queries over allowlisted tables are accepted.`,
      );
    }
    if (type === "with" && !isRoot) {
      throw new SqlRejected("WITH is only allowed at the top level of the query, not inside a subquery.");
    }
    if (type === "table") {
      const name = obj.name as { name?: unknown; schema?: unknown } | undefined;
      if (!name || typeof name.name !== "string") throw new SqlRejected("Unrecognised table reference.");
      out.tables.push({ name: name.name, ...(typeof name.schema === "string" ? { schema: name.schema } : {}) });
    } else if (type === "call") {
      const fn = obj.function as { name?: unknown; schema?: unknown } | undefined;
      if (!fn || typeof fn.name !== "string") throw new SqlRejected("Unrecognised function call.");
      out.functions.push({ name: fn.name, ...(typeof fn.schema === "string" ? { schema: fn.schema } : {}) });
    } else if (type === "ref") {
      const table = obj.table as { schema?: unknown } | undefined;
      if (table && typeof table.schema === "string" && table.schema !== "public") {
        throw new SqlRejected(`Schema ${table.schema} is not accessible.`);
      }
    } else if (type === "cast") {
      assertCastTarget(obj.to);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "_location") continue;
    walk(value, out, false, depth + 1);
  }
}

function collect(stmt: unknown): Collected {
  const out: Collected = { tables: [], functions: [] };
  walk(stmt, out, false);
  return out;
}

/**
 * Validates `sql` for a caller holding `scopes`.
 *
 * `catalog` maps allowlisted table names to their required scope. Names are
 * compared exactly: the parser lowercases unquoted identifiers, and a quoted
 * mixed-case name is a different identifier in Postgres, so it is never
 * treated as an allowlisted table.
 */
export function validateSelect(
  sql: string,
  scopes: readonly string[],
  catalog: ReadonlyMap<string, CatalogTable>,
): GuardResult {
  const trimmed = sql.trim();
  if (!trimmed) throw new SqlRejected("The query is empty.");
  if (trimmed.length > MAX_SQL_LENGTH) {
    throw new SqlRejected(`The query is too long (${trimmed.length} characters, limit ${MAX_SQL_LENGTH}).`);
  }

  // Every query needs the base scope, including one that touches no table.
  if (!hasScope(scopes, "data:read")) throw new SqlRejected("The query tool needs the data:read scope.");
  assertLexicallySafe(trimmed);

  let statements: Statement[];
  try {
    statements = parse(trimmed);
  } catch (err) {
    const first = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
    throw new SqlRejected(
      `The query could not be parsed: ${first}. Note: the parser does not support INTERSECT, EXCEPT or WITH RECURSIVE.`,
    );
  }
  if (statements.length !== 1) {
    throw new SqlRejected(`Exactly one statement is allowed, got ${statements.length}.`);
  }
  const root = statements[0]!;

  const real: TableRefName[] = [];
  const functions: { name: string; schema?: string }[] = [];
  try {
    if (root.type === "with") {
      // Non-recursive WITH: a CTE body sees only the CTEs defined before it.
      // A reference to a later (or its own) name inside a body is a real table.
      const seen = new Set<string>();
      for (const bind of root.bind) {
        const name = bind.alias.name;
        if (name !== name.toLowerCase()) {
          throw new SqlRejected(`CTE "${name}" uses a quoted or mixed-case name. Use a plain lowercase name.`);
        }
        if (catalog.has(name)) {
          throw new SqlRejected(`CTE "${name}" has the same name as a table. Rename the CTE.`);
        }
        // The whole binding, not only its statement, so nothing is skipped.
        const found = collect(bind);
        real.push(...found.tables.filter((t) => t.schema !== undefined || !seen.has(t.name)));
        functions.push(...found.functions);
        seen.add(name);
      }
      // Validate any other property of the WITH node too (fail closed).
      for (const [key, value] of Object.entries(root)) {
        if (key === "bind" || key === "in" || key === "type" || key === "_location") continue;
        const extra = collect(value);
        real.push(...extra.tables);
        functions.push(...extra.functions);
      }
      const body = collect(root.in);
      real.push(...body.tables.filter((t) => t.schema !== undefined || !seen.has(t.name)));
      functions.push(...body.functions);
    } else {
      const found = collect(root);
      if (!["select", "union", "union all", "values"].includes(root.type)) {
        throw new SqlRejected(`Only a read-only SELECT is allowed, not "${root.type}".`);
      }
      real.push(...found.tables);
      functions.push(...found.functions);
    }
  } catch (err) {
    // Deeply nested input can overflow the stack during traversal.
    if (err instanceof RangeError) throw new SqlRejected("The query is too deeply nested. Simplify it.");
    throw err;
  }

  for (const fn of functions) {
    if (fn.schema !== undefined) {
      throw new SqlRejected(`Schema-qualified function calls are not allowed (${fn.schema}.${fn.name}).`);
    }
    if (!isFunctionAllowed(fn.name)) {
      throw new SqlRejected(`Function ${fn.name}() is not on the allowlist of plain scalar and aggregate functions.`);
    }
  }

  const names = new Set<string>();
  for (const t of real) {
    if (t.schema !== undefined && t.schema !== "public") {
      throw new SqlRejected(
        `Schema ${t.schema} is not accessible. Use schema_describe for table structure and data_catalog for the table list.`,
      );
    }
    names.add(t.name);
  }

  const tables = [...names].sort();
  for (const table of tables) {
    const entry = catalog.get(table);
    if (!entry) {
      throw new SqlRejected(`Table ${table} is not available through MCP. Call data_catalog for the list.`);
    }
    if (!hasScope(scopes, entry.scope)) {
      throw new SqlRejected(`Table ${table} needs scope ${entry.scope}, which this caller does not have.`);
    }
  }
  return { tables };
}
