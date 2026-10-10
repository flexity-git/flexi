import { describe, expect, it } from "vitest";
import { callTool, visibleTools } from "./server.js";
import { caller, json, makeDeps, mockFetch, parseResult } from "./test-helpers.js";

/** A fake Shoptet product whose visibility PATCH can be applied or ignored. */
function productApi(options: { applyPatch: boolean } = { applyPatch: true }) {
  const state = { visibility: "visible" };
  const api = mockFetch((url, init) => {
    if (url.pathname !== "/api/products/p-1") return undefined;
    if (init.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { data: { visibility: string } };
      if (options.applyPatch) state.visibility = body.data.visibility;
      return json({ data: null });
    }
    return json({ data: { guid: "p-1", name: "Example mat", visibility: state.visibility } });
  });
  return { ...api, state };
}

const WRITER = ["shoptet:write:products"];
const args = { store: "sk", guid: "p-1", visibility: "hidden" };

describe("shoptet_product_visibility_set", () => {
  it("is hidden unless writes are enabled and the caller holds the write scope by name", () => {
    expect(visibleTools(makeDeps().deps, caller(WRITER)).map((t) => t.name)).not.toContain("shoptet_product_visibility_set");
    const { deps } = makeDeps({ writesEnabled: true });
    expect(visibleTools(deps, caller(WRITER)).map((t) => t.name)).toContain("shoptet_product_visibility_set");
    expect(visibleTools(deps, caller(["*"])).map((t) => t.name)).not.toContain("shoptet_product_visibility_set");
  });

  it("previews without writing, then applies with the token and verifies by re-reading", async () => {
    const api = productApi();
    const { deps, audits } = makeDeps({ writesEnabled: true, fetchImpl: api.fetchImpl });

    const preview = parseResult(await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", args));
    expect(preview).toMatchObject({ preview: true, changeNeeded: true, current: "visible", new: "hidden" });
    expect(api.requests.some((r) => r.method === "PATCH")).toBe(false);

    const applied = parseResult(
      await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", { ...args, confirm_token: preview.confirm_token }),
    );
    expect(applied).toMatchObject({ preview: false, status: "applied", previous: "visible", readBack: "hidden" });
    const patch = api.requests.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({ data: { visibility: "hidden" } });

    // The confirm token never reaches the audit log.
    expect(JSON.stringify(audits)).not.toContain(preview.confirm_token);
    expect((audits[1]!.args as Record<string, unknown>).confirm_token).toBe("[redacted]");
  });

  it("reports unverified when the re-read does not show the new value", async () => {
    const api = productApi({ applyPatch: false });
    const { deps } = makeDeps({ writesEnabled: true, fetchImpl: api.fetchImpl });
    const preview = parseResult(await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", args));
    const res = parseResult(
      await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", { ...args, confirm_token: preview.confirm_token }),
    );
    expect(res.status).toBe("unverified");
    expect(res.hint).toMatch(/NOT done/);
  });

  it("rejects a token used with tampered params, by another caller, or twice", async () => {
    const api = productApi();
    const { deps } = makeDeps({ writesEnabled: true, fetchImpl: api.fetchImpl });
    const preview = parseResult(await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", args));
    const token = preview.confirm_token as string;

    const tampered = await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", {
      ...args,
      visibility: "blocked",
      confirm_token: token,
    });
    expect(tampered.content[0]!.text).toMatch(/does not match these parameters/);

    const otherCaller = await callTool(deps, caller(WRITER, "token:2", 2), "shoptet_product_visibility_set", {
      ...args,
      confirm_token: token,
    });
    expect(otherCaller.content[0]!.text).toMatch(/different caller/);
    expect(api.requests.some((r) => r.method === "PATCH")).toBe(false);

    await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", { ...args, confirm_token: token });
    const replay = await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", { ...args, confirm_token: token });
    expect(replay.content[0]!.text).toMatch(/already used/);
    expect(api.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("refuses to write when the product changed after the preview", async () => {
    const api = productApi();
    const { deps } = makeDeps({ writesEnabled: true, fetchImpl: api.fetchImpl });
    const preview = parseResult(await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", args));
    api.state.visibility = "detail-only";
    const res = await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", { ...args, confirm_token: preview.confirm_token });
    expect(res.content[0]!.text).toMatch(/changed since the preview/);
    expect(api.requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("returns no token when nothing would change, and rejects unknown visibility values", async () => {
    const api = productApi();
    const { deps } = makeDeps({ writesEnabled: true, fetchImpl: api.fetchImpl });
    const same = parseResult(await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", { ...args, visibility: "visible" }));
    expect(same).toMatchObject({ changeNeeded: false });
    expect(same.confirm_token).toBeUndefined();
    const bad = await callTool(deps, caller(WRITER), "shoptet_product_visibility_set", { ...args, visibility: "invisible" });
    expect(bad.isError).toBe(true);
  });
});
