import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** HTTP header carrying the webhook signature. */
export const SHOPTET_WEBHOOK_SIGNATURE_HEADER = "Shoptet-Webhook-Signature";

/** Events commonly used by back-office integrations. Other values are allowed. */
export const KNOWN_WEBHOOK_EVENTS = [
  "order:create",
  "order:update",
  "order:delete",
  "order:paid",
  "order:massCreate",
  "order:massUpdate",
  "order:massPaid",
  "job:finished",
] as const;

export type KnownShoptetWebhookEvent = (typeof KNOWN_WEBHOOK_EVENTS)[number];
export type ShoptetWebhookEvent = KnownShoptetWebhookEvent | (string & {});

/** Body Shoptet POSTs to a registered webhook URL. */
export interface ShoptetWebhookPayload {
  eshopId: number;
  event: ShoptetWebhookEvent;
  eventCreated: string;
  /** Identifier of the changed entity, e.g. an order code. */
  eventInstance: string;
}

const webhookPayloadSchema = z
  .object({
    eshopId: z.coerce.number().int(),
    event: z.string().min(1),
    eventCreated: z.string().min(1),
    eventInstance: z.union([z.string(), z.number()]).transform(String),
  })
  .passthrough();

/**
 * Validate a webhook body. Call it only after `verifyWebhookSignature`
 * succeeded. Throws a `ZodError` on malformed input.
 */
export function parseWebhookPayload(input: string | unknown): ShoptetWebhookPayload {
  const value = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  const parsed = webhookPayloadSchema.parse(value);
  return {
    eshopId: parsed.eshopId,
    event: parsed.event,
    eventCreated: parsed.eventCreated,
    eventInstance: parsed.eventInstance,
  };
}

/** HMAC-SHA1 hex digest of the raw body, as Shoptet computes it. */
export function computeWebhookSignature(rawBody: string | Uint8Array, secret: string): string {
  const hmac = createHmac("sha1", secret);
  hmac.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
  return hmac.digest("hex");
}

/**
 * Verify the `Shoptet-Webhook-Signature` header against the raw request body
 * using a constant-time comparison. Pass the body exactly as received, before
 * any JSON parsing. Returns false for a missing header or empty secret.
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;
  const provided = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(provided)) return false;
  const expected = Buffer.from(computeWebhookSignature(rawBody, secret), "hex");
  return timingSafeEqual(Buffer.from(provided, "hex"), expected);
}
