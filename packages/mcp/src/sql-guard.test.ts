import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { SqlRejected, validateSelect } from "./sql-guard.js";

const catalog = buildCatalog([
  {
    name: "mirror",
    tables: [
      { name: "store_products", scope: "data:read", description: "Products" },
      { name: "store_orders", scope: "data:read", description: "Orders without personal data" },
      { name: "order_customers", scope: "data:read:customers", description: "Customer contact data" },
    ],
  },
]);

const READ = ["data:read"];
const CUSTOMERS = ["data:read", "data:read:customers"];

const accepted: Array<[string, string, string[]?]> = [
  ["plain select", "select guid, name from store_products"],
  ["params", "select * from store_products where guid = $1 and visibility = $2"],
  ["aggregate", "select count(*), sum(1) from store_orders"],
  ["join", "select p.name from store_products p join store_orders o on o.id = p.id"],
  ["cte", "with recent as (select * from store_orders) select count(*) from recent"],
  ["chained ctes", "with a as (select * from store_orders), b as (select * from a) select * from b"],
  ["subquery", "select * from (select guid from store_products) s"],
  ["exists", "select exists(select 1 from store_orders)"],
  ["union of allowed", "select guid from store_products union all select guid from store_products"],
  ["trailing semicolon", "select 1 from store_products;"],
  ["doubled quote in string", "select * from store_products where name = 'it''s'"],
  ["allowed casts", "select guid::text, 1::numeric(10,2), now()::timestamptz, '{1}'::int[] from store_products"],
  ["unicode inside string", "select * from store_products where name = 'Žltá loptička'"],
  ["quoted identifier", 'select "name" from store_products'],
  ["public schema", "select * from public.store_products"],
  ["date functions", "select date_trunc('day', now()), coalesce(null, 1) from store_orders"],
  ["any with param", "select * from store_products where guid = any($1)"],
  ["window", "select row_number() over (order by guid) from store_products"],
  ["no table", "select 1"],
  ["customers table with scope", "select * from order_customers", CUSTOMERS],
  ["wildcard reads customers", "select * from order_customers", ["*"]],
];

const rejected: Array<[string, string, RegExp, string[]?]> = [
  ["empty", "   ", /empty/],
  ["two statements", "select 1; select 2", /Exactly one statement/],
  ["comment hiding second statement", "select 1 /* x */; delete from store_products", /Comments are not allowed/],
  ["trailing comment", "select 1 from store_products -- note", /Comments are not allowed/],
  [
    "nested block comment parsers disagree on",
    "select 1 from store_products /* /* */ union select email from order_customers */",
    /Comments are not allowed/,
  ],
  ["dollar quoted string", "select $$x$$ from store_products", /Dollar quoting/],
  ["tagged dollar quote", "select $a$ ' $a$, email from order_customers", /Dollar quoting/],
  ["E string with backslash escape", "select E'a\\' union select email from order_customers --'", /String prefixes|Backslash|Comments/],
  [
    "backslash in plain string",
    "select 'a\\' from store_products union select email from order_customers where 'x' = 'x'",
    /Backslash/,
  ],
  ["unicode escape string", "select U&'d\\0061t' from store_products", /String prefixes|Backslash/],
  ["unterminated string", "select 'abc from store_products", /unterminated/],
  ["regclass array cast", "select '{1259}'::regclass[]", /Casts to regclass/],
  ["regclass array via cast()", "select cast(array[1259] as regclass[])", /Casts to regclass/],
  ["nested regclass array", "select '{{1}}'::regclass[][]", /Casts to regclass/],
  ["regrole array", "select array[10]::regrole[]", /Casts to regrole/],
  ["table composite type cast", "select to_jsonb('(,,)'::flexi_api_tokens)", /Casts to flexi_api_tokens|to_jsonb/],
  ["composite type cast in where", "select 1 from store_products where '(,)'::secrets is null", /Casts to secrets/],
  ["operator with schema", "select 1 operator(pg_catalog.=) 1", /OPERATOR/],
  ["non-breaking space", "select 1\u00a0from store_products", /ASCII/],
  ["delete", "delete from store_products", /read-only SELECT/],
  ["update", "update store_products set name = 'x'", /read-only SELECT/],
  ["insert", "insert into store_products (guid) values ('x')", /read-only SELECT/],
  ["drop", "drop table store_products", /read-only SELECT/],
  ["create", "create table x (id int)", /read-only SELECT/],
  ["truncate", "truncate store_products", /read-only SELECT/],
  ["data-modifying cte", "with x as (delete from store_products returning *) select * from x", /read-only SELECT/],
  ["set", "set role postgres", /read-only SELECT|parsed/],
  ["not allowlisted", "select * from secrets", /not available/],
  ["union to non-allowlisted", "select guid from store_products union select token_sha256 from flexi_api_tokens", /flexi_api_tokens/],
  ["subquery to non-allowlisted", "select * from store_products where guid in (select x from secrets)", /secrets/],
  ["join to non-allowlisted", "select * from store_products p join mcp_audit_log a on true", /mcp_audit_log/],
  ["information_schema", "select * from information_schema.tables", /Schema information_schema/],
  ["pg_catalog", "select * from pg_catalog.pg_authid", /Schema pg_catalog/],
  ["pg_tables unqualified", "select * from pg_tables", /not available/],
  ["other schema", "select * from private.store_products", /Schema private/],
  ["cte shadowing a table", "with store_products as (select * from secrets) select * from store_products", /same name as a table/],
  ["cte quoted uppercase", 'with "Recent" as (select 1) select * from "Recent"', /mixed-case/],
  [
    "cte name used before definition reads the real table",
    "with a as (select * from secrets), secrets as (select 1) select * from a",
    /secrets/,
  ],
  ["cte referencing itself reads the real table", "with secrets as (select * from secrets) select * from secrets", /secrets/],
  ["nested with", "select * from (with x as (select 1) select * from x) s", /top level/],
  ["quoted mixed-case table", 'select * from "Store_Products"', /not available/],
  ["for update", "select * from store_products for update", /"update" is not allowed/],
  ["pg_sleep", "select pg_sleep(10)", /pg_sleep/],
  ["pg_read_file", "select pg_read_file('/etc/passwd')", /pg_read_file/],
  ["dblink", "select * from dblink('host=x', 'select 1') as t(a int)", /dblink|parsed/],
  ["qualified function", "select pg_catalog.now()", /Schema-qualified function/],
  ["current_setting", "select current_setting('role')", /current_setting/],
  ["set_config", "select set_config('role', 'postgres', true)", /set_config/],
  ["nextval", "select nextval('x')", /nextval/],
  ["unknown function", "select my_custom_fn(1) from store_products", /my_custom_fn/],
  ["function in where", "select * from store_products where pg_sleep(1) is not null", /pg_sleep/],
  ["customers table without scope", "select * from order_customers", /needs scope data:read:customers/],
  ["customers via union without scope", "select guid from store_products union select email from order_customers", /order_customers/],
  ["customers scope without base", "select * from order_customers", /data:read scope/, ["data:read:customers"]],
  ["no scopes at all", "select 1", /data:read scope/, []],
  ["unsupported intersect", "select 1 intersect select 2", /parsed|read-only/],
  ["garbage", "select from where", /parsed/],
  ["too long", `select 1 ${" ".repeat(10_001)}x`, /too long|parsed/],
];

// Functions that execute SQL passed as a string, or read catalogs/settings.
// Each would read tables the parser never sees, so each must be rejected.
const queryExecutingFunctions = [
  "ts_stat('select email from order_customers')",
  "ts_rewrite('a'::tsquery, 'select 1')",
  "query_to_xml('select * from order_customers', true, true, '')",
  "query_to_xmlschema('select 1', true, true, '')",
  "query_to_xml_and_xmlschema('select 1', true, true, '')",
  "cursor_to_xml('c', 1, true, true, '')",
  "cursor_to_xmlschema('c', true, true, '')",
  "table_to_xml('order_customers', true, true, '')",
  "table_to_xmlschema('order_customers', true, true, '')",
  "schema_to_xml('public', true, true, '')",
  "schema_to_xmlschema('public', true, true, '')",
  "schema_to_xml_and_xmlschema('public', true, true, '')",
  "database_to_xml(true, true, '')",
  "database_to_xmlschema(true, true, '')",
  "database_to_xml_and_xmlschema(true, true, '')",
  "xpath_table('id', 'doc', 'order_customers', '/a', 'true')",
  "dblink('dbname=x', 'select 1')",
  "current_setting('search_path')",
  "set_config('role', 'x', true)",
  "pg_ls_dir('.')",
  "lo_import('/etc/passwd')",
  "version()",
];

describe("validateSelect", () => {
  it.each(accepted)("accepts: %s", (_label, sql, scopes = READ) => {
    expect(() => validateSelect(sql, scopes, catalog)).not.toThrow();
  });

  it.each(rejected)("rejects: %s", (_label, sql, message, scopes = READ) => {
    let error: unknown;
    try {
      validateSelect(sql, scopes, catalog);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SqlRejected);
    expect((error as Error).message).toMatch(message);
  });

  it.each(queryExecutingFunctions)("rejects query-executing or catalog function: %s", (call) => {
    for (const sql of [`select ${call}`, `select * from store_products where (${call}) is not null`]) {
      expect(() => validateSelect(sql, CUSTOMERS, catalog)).toThrow(SqlRejected);
    }
  });

  it("rejects xpath_table used as a FROM item with a column list", () => {
    expect(() =>
      validateSelect("select * from xpath_table('id','doc','order_customers','/a','true') as t(id int, a text)", CUSTOMERS, catalog),
    ).toThrow(SqlRejected);
  });

  it("returns the real tables read, excluding CTE names", () => {
    const res = validateSelect("with a as (select * from store_orders) select * from a join store_products p on true", READ, catalog);
    expect(res.tables).toEqual(["store_orders", "store_products"]);
  });

  it("rejects deeply nested input without crashing", () => {
    const sql = `select ${"coalesce(".repeat(3000)}1${")".repeat(3000)}`;
    expect(() => validateSelect(sql, READ, catalog)).toThrow(SqlRejected);
  });
});

// Regression for a bypass: the parser's own visitor skipped DISTINCT ON,
// window PARTITION BY / ORDER BY and JOIN ... ON of a function FROM item.
// The guard now walks every AST property. X is replaced with a forbidden
// function call or a subquery on a non-allowlisted / system table.
describe("forbidden expressions in every position", () => {
  const positions: Array<[string, string]> = [
    ["select list", "select X from store_products"],
    ["where", "select 1 from store_products where X is not null"],
    ["distinct on", "select distinct on ((X)) guid from store_products"],
    ["window partition by", "select count(*) over (partition by (X)) from store_products"],
    ["window order by", "select row_number() over (order by (X)) from store_products"],
    ["join on with function from item", "select 1 from store_products join unnest(array[1]) g on (X) is not null"],
    ["left join on", "select 1 from store_products p left join store_products q on (X) is null"],
    ["function from item argument", "select * from unnest(array[(X)]) u"],
    ["aggregate filter", "select count(*) filter (where (X) is not null) from store_products"],
    ["aggregate order by", "select string_agg(guid, ',' order by (X)) from store_products"],
    ["limit", "select 1 from store_products limit (X)"],
    ["offset", "select 1 from store_products offset (X)"],
    ["group by", "select 1 from store_products group by (X)"],
    ["having", "select 1 from store_products group by guid having (X) is not null"],
    ["order by", "select 1 from store_products order by (X)"],
    ["case", "select case when (X) is null then 1 else 2 end from store_products"],
    ["values", "select * from (values ((X))) v(a)"],
    ["array", "select array[(X)] from store_products"],
    ["array subscript", "select (array[1,2])[(X)] from store_products"],
    ["cast", "select (X)::text from store_products"],
    ["in list", "select 1 from store_products where 1 in ((X), 2)"],
    ["lateral subquery", "select * from store_products p, lateral (select X) s"],
    ["union branch", "select 1 from store_products union select X"],
    ["cte body", "with a as (select X) select * from a"],
    ["scalar subquery in select", "select (select X) from store_products"],
    ["exists", "select exists(select X) from store_products"],
    ["coalesce argument", "select coalesce((X), 1) from store_products"],
  ];
  const payloads: Array<[string, string, RegExp]> = [
    ["pg_sleep", "pg_sleep(1)", /pg_sleep/],
    ["system table subquery", "(select 1 from pg_authid)", /pg_authid/],
    ["non-allowlisted table subquery", "(select count(*) from secrets)", /secrets/],
    ["set_config", "set_config('role', 'none', true)", /set_config/],
  ];
  const cases = positions.flatMap(([pos, tpl]) => payloads.map(([p, x, re]) => [`${pos} / ${p}`, tpl.replace("X", x), re] as const));

  it.each(cases)("rejects %s", (_label, sql, re) => {
    let error: unknown;
    try {
      validateSelect(sql, CUSTOMERS, catalog);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SqlRejected);
    // Either the guard names the forbidden item, or the parser refuses the text.
    expect((error as Error).message).toMatch(new RegExp(`${re.source}|could not be parsed`));
  });

  it("the same positions with harmless content are accepted, so the rejections above are not parse failures", () => {
    const parsedFine = positions.filter(([, tpl]) => {
      try {
        validateSelect(tpl.replace("X", "1"), CUSTOMERS, catalog);
        return true;
      } catch {
        return false;
      }
    });
    // Every position except the ones the parser cannot express must validate.
    expect(parsedFine.map(([p]) => p)).toEqual(expect.arrayContaining(["distinct on", "window partition by", "join on with function from item", "where", "select list"]));
  });

  it.each(["generate_series(1, 1000000000)", "repeat('x', 1000000000)", "lpad('x', 1000000000)", "rpad('x', 1000000000)"])(
    "rejects unbounded-output function %s",
    (call) => {
      expect(() => validateSelect(`select ${call}`, READ, catalog)).toThrow(/not on the allowlist/);
    },
  );

  it.each(["select 'x'::regclass", "select 1::pg_catalog.int4", "select guid::regproc from store_products"])("rejects catalog casts: %s", (sql) => {
    expect(() => validateSelect(sql, READ, catalog)).toThrow(SqlRejected);
  });
});

describe("reported bypasses", () => {
  it.each([
    "select count(*) over (partition by (select 1 from pg_authid)) from store_orders",
    "select distinct on ((select 1 from pg_authid)) 1",
    "select 1 from store_orders join generate_series(1,2) g on (select 1 from pg_authid) is not null",
    "select 1 from store_orders left join generate_series(1,2) g on pg_sleep(1) is null",
    "select 1 from store_orders left join unnest(array[1]) g on pg_sleep(1) is null",
    "select 1 from store_orders join unnest(array[1]) g on (select 1 from pg_authid) is not null",
    "select count(*) over (partition by (select token_sha256 from flexi_api_tokens)::int) from store_orders",
  ])("rejects %s", (sql) => {
    expect(() => validateSelect(sql, CUSTOMERS, catalog)).toThrow(SqlRejected);
  });
});
