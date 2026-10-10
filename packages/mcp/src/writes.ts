import { ToolError } from "./errors.js";
import type { ConfirmTokens } from "./confirm.js";
import type { ClientFactory } from "./shoptet-live.js";

/**
 * Product visibility values accepted by the Shoptet Private API.
 * Source: the product `visibility` enum at https://developers.shoptet.com/.
 */
export const PRODUCT_VISIBILITIES = [
  "visible",
  "hidden",
  "blocked",
  "show-registered",
  "block-unregistered",
  "cash-desk-only",
  "detail-only",
] as const;

export const VISIBILITY_TOOL = "shoptet_product_visibility_set";

async function readVisibility(clients: ClientFactory, store: string, guid: string): Promise<{ name: string | null; visibility: string }> {
  const res = (await clients(store).getProduct(guid)) as { data?: { name?: unknown; visibility?: unknown } };
  const visibility = res?.data?.visibility;
  if (typeof visibility !== "string") throw new ToolError(`Shoptet returned no visibility for product ${guid}.`);
  return { name: typeof res.data?.name === "string" ? res.data.name : null, visibility };
}

/**
 * Two-step product visibility change.
 * Without `confirmToken`: preview (current vs new) plus a confirm token.
 * With it: verify the token, check nothing changed since the preview, PATCH,
 * then re-read and report `applied` or `unverified`.
 */
export async function setProductVisibility(input: {
  clients: ClientFactory;
  confirm: ConfirmTokens;
  caller: string;
  store: string;
  guid: string;
  visibility: string;
  confirmToken?: string;
}) {
  const { clients, confirm, caller, store, guid, visibility } = input;
  if (!(PRODUCT_VISIBILITIES as readonly string[]).includes(visibility)) {
    throw new ToolError(`Unknown visibility "${visibility}". Allowed: ${PRODUCT_VISIBILITIES.join(", ")}.`);
  }
  const params = { store, guid, visibility };

  if (!input.confirmToken) {
    const current = await readVisibility(clients, store, guid);
    if (current.visibility === visibility) {
      return { preview: true, changeNeeded: false, store, guid, name: current.name, current: current.visibility, hint: "Already set. Nothing to do." };
    }
    const { token, expiresAt } = confirm.issue({ tool: VISIBILITY_TOOL, caller, params, from: current.visibility });
    return {
      preview: true,
      changeNeeded: true,
      store,
      guid,
      name: current.name,
      current: current.visibility,
      new: visibility,
      confirm_token: token,
      expiresAt,
      hint: "Nothing changed yet. Show this preview to a human and, only after they approve, call again with the same store, guid and visibility plus confirm_token.",
    };
  }

  const { from } = confirm.consume(input.confirmToken, { tool: VISIBILITY_TOOL, caller, params });
  const before = await readVisibility(clients, store, guid);
  if (before.visibility !== from) {
    throw new ToolError(
      `Visibility changed since the preview (preview saw "${from}", now "${before.visibility}"). Nothing was written; run a new preview.`,
    );
  }

  await clients(store).request("PATCH", `/api/products/${encodeURIComponent(guid)}`, {
    body: { data: { visibility } },
    idempotent: true,
  });

  const after = await readVisibility(clients, store, guid);
  const verified = after.visibility === visibility;
  return {
    preview: false,
    status: verified ? "applied" : "unverified",
    store,
    guid,
    name: after.name,
    previous: before.visibility,
    requested: visibility,
    readBack: after.visibility,
    ...(verified
      ? {}
      : { hint: "Shoptet accepted the request but the re-read shows a different value. Treat this as NOT done and check in the Shoptet admin." }),
  };
}
