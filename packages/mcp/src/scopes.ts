/**
 * Permission scopes for MCP callers (HTTP tokens and the stdio process).
 *
 * Pure functions, no I/O, so the authorization logic is fully unit-testable.
 */

export const KNOWN_SCOPES = ["data:read", "data:read:customers", "shoptet:read", "shoptet:write:products"] as const;

export type Scope = (typeof KNOWN_SCOPES)[number];

/** Grants every read scope. Never grants a scope listed in WILDCARD_EXEMPT_SCOPES. */
export const WILDCARD = "*";

/** Scopes that change what customers see. They must always be listed by name. */
export const WILDCARD_EXEMPT_SCOPES: readonly string[] = ["shoptet:write:products"];

/** A scope that only extends another one: holding it alone grants nothing. */
export const SCOPE_REQUIRES: Readonly<Record<string, string>> = {
  "data:read:customers": "data:read",
};

/** Default scopes for the stdio transport when FLEXI_MCP_SCOPES is unset. */
export const DEFAULT_STDIO_SCOPES = ["data:read", "shoptet:read"] as const;

function holds(granted: readonly string[], scope: string): boolean {
  if (granted.includes(scope)) return true;
  if (WILDCARD_EXEMPT_SCOPES.includes(scope)) return false;
  return granted.includes(WILDCARD);
}

/**
 * Does a caller with `granted` scopes hold `required`?
 *
 * - exact match, no prefix matching (`data:*` is not a thing);
 * - `*` grants everything except WILDCARD_EXEMPT_SCOPES;
 * - an extending scope (e.g. `data:read:customers`) also needs its base scope;
 * - an empty list grants nothing.
 */
export function hasScope(granted: readonly string[] | null | undefined, required: string): boolean {
  if (!granted || granted.length === 0) return false;
  const req = required.trim();
  if (!req) return false;
  if (!holds(granted, req)) return false;
  const base = SCOPE_REQUIRES[req];
  return base === undefined || hasScope(granted, base);
}

export interface NormalizedScopes {
  scopes: string[];
  unknown: string[];
  /** Human-readable problems, e.g. an extending scope without its base. */
  problems: string[];
}

/** Splits, trims, de-duplicates and validates a scope list. */
export function normalizeScopes(input: readonly string[] | string): NormalizedScopes {
  const parts = typeof input === "string" ? input.split(",") : input;
  const known = new Set<string>([...KNOWN_SCOPES, WILDCARD]);
  const scopes: string[] = [];
  const unknown: string[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    if (known.has(s)) {
      if (!scopes.includes(s)) scopes.push(s);
    } else if (!unknown.includes(s)) {
      unknown.push(s);
    }
  }
  const problems: string[] = [];
  for (const s of scopes) {
    const base = SCOPE_REQUIRES[s];
    if (base && !scopes.includes(base) && !scopes.includes(WILDCARD)) {
      problems.push(`${s} extends ${base} and does nothing without it; add ${base}.`);
    }
  }
  return { scopes, unknown, problems };
}

/** Parses a scope list and throws on unknown scopes or problems. */
export function parseScopesStrict(input: readonly string[] | string, source: string): string[] {
  const { scopes, unknown, problems } = normalizeScopes(input);
  const issues = [
    ...unknown.map((u) => `unknown scope "${u}" (known: ${KNOWN_SCOPES.join(", ")}, ${WILDCARD})`),
    ...problems,
  ];
  if (issues.length > 0) throw new Error(`${source}: ${issues.join("; ")}`);
  if (scopes.length === 0) throw new Error(`${source}: at least one scope is required.`);
  return scopes;
}
