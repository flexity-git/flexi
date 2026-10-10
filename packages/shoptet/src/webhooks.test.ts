import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { computeWebhookSignature, parseWebhookPayload, verifyWebhookSignature } from "./webhooks.js";

const SECRET = "fake-webhook-secret";
const BODY = JSON.stringify({
  eshopId: 123456,
  event: "order:create",
  eventCreated: "2026-03-01T10:15:00+0100",
  eventInstance: "1001",
});

describe("verifyWebhookSignature", () => {
  const valid = createHmac("sha1", SECRET).update(BODY, "utf8").digest("hex");

  it("accepts a valid signature", () => {
    expect(computeWebhookSignature(BODY, SECRET)).toBe(valid);
    expect(verifyWebhookSignature(BODY, valid, SECRET)).toBe(true);
  });

  it("accepts an uppercase hex header and a Buffer body", () => {
    expect(verifyWebhookSignature(Buffer.from(BODY), valid.toUpperCase(), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyWebhookSignature(BODY.replace("1001", "1002"), valid, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(verifyWebhookSignature(BODY, valid, "other-secret")).toBe(false);
  });

  it("rejects missing, malformed or wrong-length headers", () => {
    expect(verifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "zz", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, valid.slice(0, 38), SECRET)).toBe(false);
  });

  it("rejects when the secret is empty", () => {
    expect(verifyWebhookSignature(BODY, valid, "")).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  it("parses a raw body", () => {
    expect(parseWebhookPayload(BODY)).toEqual({
      eshopId: 123456,
      event: "order:create",
      eventCreated: "2026-03-01T10:15:00+0100",
      eventInstance: "1001",
    });
  });

  it("coerces a numeric eventInstance to string", () => {
    expect(
      parseWebhookPayload({ eshopId: 1, event: "job:finished", eventCreated: "x", eventInstance: 42 }).eventInstance,
    ).toBe("42");
  });

  it("throws on malformed payloads", () => {
    expect(() => parseWebhookPayload({ event: "order:create" })).toThrow();
  });
});
