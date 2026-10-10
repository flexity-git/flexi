import { describe, expect, it } from "vitest";
import { ConfirmTokenError, createConfirmTokens } from "./confirm.js";

const SECRET = "test-secret-not-real-0000000000000000";
const params = { store: "sk", guid: "guid-1", visibility: "hidden" };
const claims = { tool: "shoptet_product_visibility_set", caller: "token:1", params, from: "visible" };

function tokens(now = { t: 1_000_000 }) {
  return { now, confirm: createConfirmTokens({ secret: SECRET, now: () => now.t }) };
}

describe("confirm tokens", () => {
  it("round-trips once and returns the previewed state", () => {
    const { confirm } = tokens();
    const { token, expiresAt } = confirm.issue(claims);
    expect(new Date(expiresAt).getTime()).toBe(1_000_000 + 10 * 60 * 1000);
    expect(confirm.consume(token, { tool: claims.tool, caller: claims.caller, params })).toEqual({ from: "visible" });
    expect(() => confirm.consume(token, { tool: claims.tool, caller: claims.caller, params })).toThrow(/already used/);
  });

  it.each([
    ["different visibility", { ...params, visibility: "visible" }],
    ["different guid", { ...params, guid: "guid-2" }],
    ["different store", { ...params, store: "cz" }],
  ])("rejects tampered params: %s", (_label, other) => {
    const { confirm } = tokens();
    const { token } = confirm.issue(claims);
    expect(() => confirm.consume(token, { tool: claims.tool, caller: claims.caller, params: other })).toThrow(/does not match/);
  });

  it("rejects another caller and another tool", () => {
    const { confirm } = tokens();
    const { token } = confirm.issue(claims);
    expect(() => confirm.consume(token, { tool: claims.tool, caller: "token:2", params })).toThrow(/different caller/);
    expect(() => confirm.consume(token, { tool: "other_tool", caller: claims.caller, params })).toThrow(/different tool/);
  });

  it("rejects a modified payload even if the signature part is kept", () => {
    const { confirm } = tokens();
    const { token } = confirm.issue(claims);
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
    payload.params.visibility = "visible";
    payload.from = "hidden";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(() => confirm.consume(forged, { tool: claims.tool, caller: claims.caller, params: payload.params })).toThrow(
      /signature is invalid/,
    );
  });

  it("rejects tokens from another secret, malformed tokens and expired tokens", () => {
    const { confirm, now } = tokens();
    const other = createConfirmTokens({ secret: "another-secret-not-real-000000000000" }).issue(claims).token;
    expect(() => confirm.consume(other, { tool: claims.tool, caller: claims.caller, params })).toThrow(ConfirmTokenError);
    expect(() => confirm.consume("garbage", { tool: claims.tool, caller: claims.caller, params })).toThrow(/malformed/);
    const { token } = confirm.issue(claims);
    now.t += 10 * 60 * 1000 + 1;
    expect(() => confirm.consume(token, { tool: claims.tool, caller: claims.caller, params })).toThrow(/expired/);
  });
});
