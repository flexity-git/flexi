import { afterEach, describe, expect, it, vi } from "vitest";

import { createShoptetClient } from "./client.js";
import { ShoptetApiError, ShoptetNetworkError } from "./errors.js";
import type { ShoptetEvent } from "./events.js";
import { BASE_URL, FAKE_TOKEN, jsonResponse } from "./test-helpers.js";

function makeClient(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createShoptetClient>[0]> = {}) {
  const events: ShoptetEvent[] = [];
  const client = createShoptetClient({
    token: FAKE_TOKEN,
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    onEvent: (e) => events.push(e),
    retry: { baseDelayMs: 10, maxDelayMs: 100 },
    ...extra,
  });
  return { client, events };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("request basics", () => {
  it("sends the token header and query, and builds the URL on the API host", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { orders: [] } }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);

    await client.getOrders({ statusId: 2, email: undefined });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`${BASE_URL}/api/orders?statusId=2`);
    expect((init.headers as Record<string, string>)["Shoptet-Private-API-Token"]).toBe(FAKE_TOKEN);
    expect(init.method).toBe("GET");
  });

  it("passes include for detail endpoints", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: { order: { code: "1001" } } }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.getOrder("1001", { include: "notes" });
    expect(res.data.order.code).toBe("1001");
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.toString()).toBe(`${BASE_URL}/api/orders/1001?include=notes`);
  });

  it("rejects paths that would leave the API host", async () => {
    const { client } = makeClient(vi.fn() as unknown as typeof fetch);
    await expect(client.request("GET", "//evil.example/x")).rejects.toThrow(TypeError);
    await expect(client.request("GET", "https://evil.example/x")).rejects.toThrow(TypeError);
  });
});

describe("concurrency", () => {
  it("never runs more than maxConcurrency requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return jsonResponse({ data: {} });
    });
    const { client } = makeClient(fetchMock as unknown as typeof fetch);

    await Promise.all(Array.from({ length: 12 }, () => client.getEshopInfo()));

    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(peak).toBe(3);
  });

  it("honours a custom maxConcurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return jsonResponse({ data: {} });
    });
    const { client } = makeClient(fetchMock as unknown as typeof fetch, { maxConcurrency: 1 });
    await Promise.all(Array.from({ length: 4 }, () => client.getEshopInfo()));
    expect(peak).toBe(1);
  });
});

describe("retries", () => {
  it("waits for Retry-After (seconds) on 429 before retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [] }, { status: 429, headers: { "Retry-After": "5" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const { client, events } = makeClient(fetchMock as unknown as typeof fetch);

    const promise = client.getEshopInfo();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "rate_limited", retryAfter: "5", delayMs: 5_000, path: "/api/eshop" }),
    );
  });

  it("accepts Retry-After as an HTTP date and caps it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({}, { status: 429, headers: { "Retry-After": "Thu, 01 Jan 2026 01:00:00 GMT" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    const { client, events } = makeClient(fetchMock as unknown as typeof fetch, {
      retry: { maxRetryAfterMs: 2_000 },
    });
    const promise = client.getEshopInfo();
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(events[0]).toMatchObject({ type: "rate_limited", delayMs: 2_000 });
  });

  it("retries 5xx with backoff and then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ data: { stocks: [] } }));
    const { client, events } = makeClient(fetchMock as unknown as typeof fetch);

    const promise = client.getStocks();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ data: { stocks: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retries = events.filter((e) => e.type === "retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ reason: "server_error", status: 503, attempt: 1 });
  });

  it("retries 423 (locked)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 423 }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    const { client, events } = makeClient(fetchMock as unknown as typeof fetch);
    const promise = client.getEshopInfo();
    await vi.runAllTimersAsync();
    await promise;
    expect(events[0]).toMatchObject({ type: "retry", reason: "locked" });
  });

  it("gives up after maxAttempts and throws ShoptetApiError", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 502 }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch, {
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    const promise = client.getEshopInfo().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(ShoptetApiError);
    expect((err as ShoptetApiError).attempts).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a POST on 5xx (not idempotent)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 500 }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.request("POST", "/api/orders", { body: { data: {} } })).rejects.toBeInstanceOf(
      ShoptetApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network errors and then throws ShoptetNetworkError", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { client, events } = makeClient(fetchMock as unknown as typeof fetch, {
      retry: { maxAttempts: 2, baseDelayMs: 1 },
    });
    const promise = client.getEshopInfo().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(ShoptetNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events[0]).toMatchObject({ type: "retry", reason: "network" });
  });
});

describe("errors", () => {
  it("parses Shoptet error codes and messages without leaking the token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          data: null,
          errors: [
            { errorCode: "invalid-parameter", message: "Unsupported query parameters found: foo", instance: "/foo" },
            { errorCode: "echo", message: `token was ${FAKE_TOKEN}` },
          ],
          metadata: { requestId: "req-123" },
        },
        { status: 400 },
      ),
    );
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const err = (await client.getOrders({ foo: "bar" }).catch((e: unknown) => e)) as ShoptetApiError;

    expect(err).toBeInstanceOf(ShoptetApiError);
    expect(err.status).toBe(400);
    expect(err.requestId).toBe("req-123");
    expect(err.errorCodes).toEqual(["invalid-parameter", "echo"]);
    expect(err.errors[0]).toEqual({
      errorCode: "invalid-parameter",
      message: "Unsupported query parameters found: foo",
      instance: "/foo",
    });
    expect(err.path).toBe("/api/orders");
    expect(err.message).toContain("/foo: Unsupported query parameters found: foo");
    const serialized = JSON.stringify({ message: err.message, body: err.body, errors: err.errors });
    expect(serialized).not.toContain(FAKE_TOKEN);
  });

  it("handles a non-JSON error body", async () => {
    const fetchMock = vi.fn(async () => new Response("Bad gateway", { status: 400, statusText: "Bad Request" }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const err = (await client.getEshopInfo().catch((e: unknown) => e)) as ShoptetApiError;
    expect(err.status).toBe(400);
    expect(err.errors).toEqual([]);
    expect(err.message).toContain("400");
  });
});

describe("observability headers", () => {
  it("emits a deprecation event once per path", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: {} }, { headers: { "X-Shoptet-Deprecated": "true", Sunset: "2027-01-01" } }),
    );
    const { client, events } = makeClient(fetchMock as unknown as typeof fetch);
    await client.getEshopInfo();
    await client.getEshopInfo();
    expect(events.filter((e) => e.type === "deprecation")).toEqual([
      { type: "deprecation", method: "GET", path: "/api/eshop", deprecated: "true", sunset: "2027-01-01" },
    ]);
  });
});

describe("webhook API helpers", () => {
  it("registers each event separately and reports failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: { webhooks: [{ id: 1, event: "order:create", url: "https://shop.example/hook" }] } }),
      )
      .mockResolvedValueOnce(jsonResponse({ errors: [{ errorCode: "invalid-event" }] }, { status: 400 }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    const res = await client.registerWebhooks([
      { event: "order:create", url: "https://shop.example/hook" },
      { event: "order:nope", url: "https://shop.example/hook" },
    ]);
    expect(res.registered).toHaveLength(1);
    expect(res.failed[0]?.event).toBe("order:nope");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      data: [{ event: "order:create", url: "https://shop.example/hook" }],
    });
  });

  it("renews the signature key and validates the response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { signatureKey: "fake-key" } }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    const { client } = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.renewWebhookSignatureKey()).resolves.toEqual({ signatureKey: "fake-key" });
    await expect(client.renewWebhookSignatureKey()).rejects.toThrow(/signatureKey/);
  });
});
