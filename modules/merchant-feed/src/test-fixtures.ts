// Synthetic test data and helpers. Not exported from the package.
import type { MirrorRows } from "./mapping.js";
import type { FeedItem, MirrorCategory, MirrorProduct, MirrorVariant } from "./types.js";

export const STORE_URL = "https://shop.example";

export function product(over: Partial<MirrorProduct> = {}): MirrorProduct {
  return {
    guid: "p-1",
    name: "Example Mat",
    visibility: "visible",
    brand: "ExampleBrand",
    default_category_guid: "c-mats",
    url: "/example-mat/",
    deleted_at: null,
    ...over,
  };
}

export function variant(over: Partial<MirrorVariant> = {}): MirrorVariant {
  return {
    code: "MAT-1",
    product_guid: "p-1",
    name: null,
    ean: "4006381333931",
    price_with_vat: "29.90",
    action_price_with_vat: null,
    currency: "EUR",
    stock: "5",
    availability_name: "Sold out",
    availability_in_stock_name: "In stock",
    visible: true,
    image_url: "https://cdn.shop.example/img/mat.jpg",
    weight: "1.2",
    ...over,
  };
}

export const categories: MirrorCategory[] = [
  { guid: "c-root", parent_guid: null, name: "Sport", url: "/sport/", visible: true },
  { guid: "c-mats", parent_guid: "c-root", name: "Mats", url: "/mats/", visible: true },
];

export function rows(over: Partial<MirrorRows> = {}): MirrorRows {
  return { products: [product()], variants: [variant()], categories, ...over };
}

export function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "MAT-1",
    itemGroupId: "p-1",
    title: "Example Mat",
    link: "https://shop.example/example-mat/",
    imageLink: "https://cdn.shop.example/img/mat.jpg",
    price: 29.9,
    currency: "EUR",
    availability: "in_stock",
    gtin: "4006381333931",
    brand: "ExampleBrand",
    categoryGuids: ["c-mats", "c-root"],
    categoryPath: ["Sport", "Mats"],
    labels: {},
    ...over,
  };
}

/**
 * Minimal XML well-formedness check for tests: balanced tags, a single root,
 * no raw `<` or bare `&` in text, quoted attributes. Throws on the first problem.
 */
export function assertWellFormedXml(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  const stack: string[] = [];
  let roots = 0;
  const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(body)) !== null) {
    const [, closing, name, , selfClosing, text, stray] = match;
    if (stray) throw new Error(`Malformed tag near offset ${match.index}`);
    if (text !== undefined) {
      if (stack.length === 0 && text.trim() !== "") throw new Error("Text outside the root element");
      if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) throw new Error(`Bare & in "${text}"`);
      continue;
    }
    if (closing) {
      const open = stack.pop();
      if (open !== name) throw new Error(`Closing </${name}> does not match <${open}>`);
    } else if (!selfClosing) {
      if (stack.length === 0) roots += 1;
      stack.push(name!);
    } else if (stack.length === 0) roots += 1;
  }
  if (stack.length > 0) throw new Error(`Unclosed <${stack.at(-1)}>`);
  if (roots !== 1) throw new Error(`Expected one root element, found ${roots}`);
}
