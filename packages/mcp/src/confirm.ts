import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, single-use confirm tokens for two-step write tools.
 *
 * A preview call returns a token that is an HMAC over the exact parameters,
 * the value seen in the preview, the caller and an expiry. The apply call must
 * present the same parameters from the same caller before the expiry. It
 * cannot prove a human looked at the preview, but it does make a one-call
 * write impossible and binds the write to what was previewed.
 */

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export interface ConfirmClaims {
  tool: string;
  caller: string;
  /** Exact parameters of the write, e.g. { store, guid, visibility }. */
  params: Record<string, string>;
  /** State shown in the preview; the apply step re-reads and compares. */
  from: string;
}

interface Payload extends ConfirmClaims {
  exp: number;
  nonce: string;
}

export class ConfirmTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmTokenError";
  }
}

function canonical(params: Record<string, string>): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
}

export interface ConfirmTokens {
  issue(claims: ConfirmClaims): { token: string; expiresAt: string };
  /** Verifies and consumes a token. Returns the `from` state recorded at preview time. */
  consume(token: string, expected: Omit<ConfirmClaims, "from">): { from: string };
}

export function createConfirmTokens(options: { secret?: string; now?: () => number; ttlMs?: number } = {}): ConfirmTokens {
  // A per-process random secret is fine: a token only has to survive the
  // minutes between preview and apply in the same server process.
  const secret = options.secret && options.secret.length >= 32 ? options.secret : randomBytes(32).toString("hex");
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? CONFIRM_TTL_MS;
  const used = new Map<string, number>();

  const sign = (body: string) => createHmac("sha256", secret).update(body).digest("base64url");

  function sweep(): void {
    const t = now();
    for (const [nonce, exp] of used) if (exp < t) used.delete(nonce);
  }

  return {
    issue(claims) {
      const payload: Payload = { ...claims, params: { ...claims.params }, exp: now() + ttl, nonce: randomBytes(12).toString("base64url") };
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return { token: `${body}.${sign(body)}`, expiresAt: new Date(payload.exp).toISOString() };
    },

    consume(token, expected) {
      const [body, sig, extra] = token.trim().split(".");
      if (!body || !sig || extra !== undefined) throw new ConfirmTokenError("confirm_token is malformed. Run the preview again.");
      const good = Buffer.from(sign(body));
      const given = Buffer.from(sig);
      if (good.length !== given.length || !timingSafeEqual(good, given)) {
        throw new ConfirmTokenError("confirm_token signature is invalid. Run the preview again.");
      }
      let payload: Payload;
      try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
      } catch {
        throw new ConfirmTokenError("confirm_token is malformed. Run the preview again.");
      }
      if (payload.tool !== expected.tool) throw new ConfirmTokenError("confirm_token belongs to a different tool.");
      if (payload.caller !== expected.caller) {
        throw new ConfirmTokenError("confirm_token was issued to a different caller. Run your own preview.");
      }
      if (canonical(payload.params) !== canonical(expected.params)) {
        throw new ConfirmTokenError(
          "confirm_token does not match these parameters. Call again with exactly the parameters from the preview, or run a new preview.",
        );
      }
      if (now() > payload.exp) throw new ConfirmTokenError("confirm_token has expired. Run the preview again.");
      sweep();
      if (used.has(payload.nonce)) throw new ConfirmTokenError("confirm_token was already used. Each preview allows one write.");
      used.set(payload.nonce, payload.exp);
      return { from: payload.from };
    },
  };
}
