import { z } from "zod";

/** Logical Slack channels. Each maps to one incoming webhook. */
export const SLACK_CHANNELS = ["alerts", "orders", "products"] as const;
export type SlackChannel = (typeof SLACK_CHANNELS)[number];

export interface StoreConfig {
  /** Lowercase key chosen by the merchant, e.g. `sk`. */
  key: string;
  /** Shoptet Private API token. Never log or print it. */
  token: string;
  /** Optional public URL of the store. */
  url?: string;
}

export interface FlexiConfig {
  stores: StoreConfig[];
  /** Key of the store treated as source of truth. */
  primaryStore: string;
  databaseUrl?: string;
  /** Webhook URL per configured channel. Missing channel = notifier logs instead. */
  slack: Partial<Record<SlackChannel, string>>;
  /** IANA time zone for business-day math. */
  timezone: string;
  /** Enabled module names in order, or null for "all installed". */
  modules: string[] | null;
}

export type Env = Record<string, string | undefined>;

export const DEFAULT_TIMEZONE = "Europe/Prague";

/** Thrown when the environment does not describe a valid configuration. */
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid flexi configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const STORE_KEY = /^[a-z][a-z0-9_]*$/;
const MODULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

// Error messages are written by hand on purpose: they name the variable and
// never include its value, because values may be tokens or webhook URLs.
const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
});

const postgresUrl = z.string().refine((value) => /^postgres(?:ql)?:\/\//i.test(value));

const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
});

function nonEmpty(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function storeTokenVar(key: string): string {
  return `SHOPTET_TOKEN_${key.toUpperCase()}`;
}

export function storeUrlVar(key: string): string {
  return `SHOPTET_STORE_${key.toUpperCase()}_URL`;
}

export function slackWebhookVar(channel: SlackChannel): string {
  return `FLEXI_SLACK_WEBHOOK_${channel.toUpperCase()}`;
}

/**
 * Reads and validates flexi configuration from environment variables.
 * Collects every problem before throwing, so one run shows everything to fix.
 */
export function loadConfig(env: Env = process.env): FlexiConfig {
  const issues: string[] = [];

  const storeKeys = csv.parse(env.FLEXI_STORES);
  if (storeKeys.length === 0) {
    issues.push("FLEXI_STORES is missing. Set it to comma-separated store keys, e.g. FLEXI_STORES=sk,cz.");
  }

  const seen = new Set<string>();
  const stores: StoreConfig[] = [];
  for (const key of storeKeys) {
    if (!STORE_KEY.test(key)) {
      issues.push(
        `FLEXI_STORES contains invalid key "${key}". Keys are lowercase letters, digits and underscores, starting with a letter.`,
      );
      continue;
    }
    if (seen.has(key)) {
      issues.push(`FLEXI_STORES lists "${key}" more than once.`);
      continue;
    }
    seen.add(key);

    const token = nonEmpty(env, storeTokenVar(key));
    if (!token) issues.push(`${storeTokenVar(key)} is missing (Shoptet Private API token for store "${key}").`);

    const url = nonEmpty(env, storeUrlVar(key));
    if (url !== undefined && !httpUrl.safeParse(url).success) {
      issues.push(`${storeUrlVar(key)} is not a valid http(s) URL.`);
    }

    stores.push({ key, token: token ?? "", ...(url !== undefined ? { url } : {}) });
  }

  const primaryRaw = nonEmpty(env, "FLEXI_PRIMARY_STORE");
  const primaryStore = primaryRaw ?? storeKeys[0] ?? "";
  if (primaryRaw !== undefined && storeKeys.length > 0 && !seen.has(primaryRaw)) {
    issues.push(`FLEXI_PRIMARY_STORE is "${primaryRaw}", which is not listed in FLEXI_STORES.`);
  }

  const databaseUrl = nonEmpty(env, "FLEXI_DATABASE_URL");
  if (databaseUrl !== undefined && !postgresUrl.safeParse(databaseUrl).success) {
    issues.push("FLEXI_DATABASE_URL must start with postgres:// or postgresql://.");
  }

  const slack: Partial<Record<SlackChannel, string>> = {};
  for (const channel of SLACK_CHANNELS) {
    const name = slackWebhookVar(channel);
    const value = nonEmpty(env, name);
    if (value === undefined) continue;
    if (!httpUrl.safeParse(value).success) {
      issues.push(`${name} is not a valid http(s) URL.`);
      continue;
    }
    slack[channel] = value;
  }

  const tz = nonEmpty(env, "FLEXI_TIMEZONE") ?? DEFAULT_TIMEZONE;
  if (!timezone.safeParse(tz).success) {
    issues.push(`FLEXI_TIMEZONE "${tz}" is not a valid IANA time zone, e.g. Europe/Prague.`);
  }

  const moduleNames = csv.parse(env.FLEXI_MODULES);
  const moduleSeen = new Set<string>();
  for (const name of moduleNames) {
    if (!MODULE_NAME.test(name)) issues.push(`FLEXI_MODULES contains invalid module name "${name}" (expected kebab-case).`);
    if (moduleSeen.has(name)) issues.push(`FLEXI_MODULES lists "${name}" more than once.`);
    moduleSeen.add(name);
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    stores,
    primaryStore,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    slack,
    timezone: tz,
    modules: moduleNames.length > 0 ? moduleNames : null,
  };
}

/** Returns the store config for `key`, or throws a clear error. */
export function getStore(config: FlexiConfig, key: string): StoreConfig {
  const store = config.stores.find((s) => s.key === key);
  if (!store) {
    const known = config.stores.map((s) => s.key).join(", ");
    throw new Error(`Unknown store "${key}". Configured stores: ${known || "(none)"}.`);
  }
  return store;
}

/** A copy of the config that is safe to print: tokens, webhooks and DB URL are masked. */
export function redactConfig(config: FlexiConfig): Record<string, unknown> {
  return {
    stores: config.stores.map((s) => ({ key: s.key, token: "***", ...(s.url ? { url: s.url } : {}) })),
    primaryStore: config.primaryStore,
    databaseUrl: config.databaseUrl ? "***" : null,
    slack: Object.fromEntries(Object.keys(config.slack).map((channel) => [channel, "***"])),
    timezone: config.timezone,
    modules: config.modules,
  };
}
