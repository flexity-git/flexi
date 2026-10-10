import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";
import { createNotifier } from "./notifier.js";

function capture() {
  const lines: any[] = [];
  return { lines, log: createLogger({}, { write: (line) => lines.push(JSON.parse(line)) }) };
}

describe("createNotifier", () => {
  it("logs instead of sending when no webhook is configured", async () => {
    const { lines, log } = capture();
    const fetch = vi.fn();
    const notifier = createNotifier({ slack: {} }, { fetch, log });
    expect(notifier.isConfigured("alerts")).toBe(false);
    await expect(notifier.notify("alerts", "hello")).resolves.toEqual({ delivered: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ level: "info", channel: "alerts", text: "hello" });
  });

  it("posts JSON to the channel webhook", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const notifier = createNotifier(
      { slack: { orders: "https://hooks.example/orders" } },
      { fetch: fetch as unknown as typeof globalThis.fetch, log: capture().log },
    );
    await expect(notifier.notify("orders", "order stuck", { blocks: [{ type: "divider" }] })).resolves.toEqual({
      delivered: true,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example/orders");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "order stuck", blocks: [{ type: "divider" }] });
  });

  it("never throws on HTTP errors or network failures", async () => {
    const { lines, log } = capture();
    const failing = vi
      .fn()
      .mockResolvedValueOnce(new Response("invalid_payload", { status: 400 }))
      .mockRejectedValueOnce(new Error("network down"));
    const notifier = createNotifier({ slack: { alerts: "https://hooks.example/a" } }, { fetch: failing, log });
    await expect(notifier.notify("alerts", "x")).resolves.toEqual({ delivered: false });
    await expect(notifier.notify("alerts", "y")).resolves.toEqual({ delivered: false });
    expect(lines.map((l) => l.level)).toEqual(["error", "error"]);
    expect(lines[0]).toMatchObject({ status: 400, body: "invalid_payload" });
    expect(lines[1]).toMatchObject({ error: "network down" });
    expect(JSON.stringify(lines)).not.toContain("hooks.example");
  });
});
