import { describe, expect, it } from "vitest";
import { comparisonItemId, renderGoogle, renderHeureka, renderZbozi } from "./render.js";
import { assertWellFormedXml, item } from "./test-fixtures.js";
import { xmlEscape } from "./xml.js";

const nasty = item({
  id: "NASTY-1",
  itemGroupId: "p-2",
  title: `Mat "Pro" <XL> & more's \u0007`,
  brand: "A&B <Co>",
  categoryPath: ["Sport & Fun", "Mats <new>"],
  link: "https://shop.example/mat/?a=1&b=2",
});

const variants = [
  item({ id: "V-RED", title: "Example Mat Red", salePrice: 19.9, labels: { custom_label_0: "sale" } }),
  item({ id: "V-BLUE", title: "Example Mat Blue", availability: "out_of_stock", gtin: undefined }),
  nasty,
];

describe("xmlEscape", () => {
  it("escapes the five XML specials and strips invalid control characters", () => {
    expect(xmlEscape(`a&b<c>d"e'f\u0001g`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;fg");
  });
});

describe("renderGoogle", () => {
  const xml = renderGoogle(variants, { title: "Test feed", storeUrl: "https://shop.example" });

  it("is well-formed RSS with the g: namespace", () => {
    assertWellFormedXml(xml);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="utf-8"\?>\n<rss version="2.0" xmlns:g="http:\/\/base.google.com\/ns\/1.0">/);
    expect(xml.match(/<item>/g)).toHaveLength(3);
  });

  it("emits the expected item fields", () => {
    expect(xml).toContain("<g:id>V-RED</g:id>");
    expect(xml).toContain("<g:price>29.90 EUR</g:price>");
    expect(xml).toContain("<g:sale_price>19.90 EUR</g:sale_price>");
    expect(xml).toContain("<g:availability>out_of_stock</g:availability>");
    expect(xml).toContain("<g:gtin>4006381333931</g:gtin>");
    expect(xml).toContain("<g:product_type>Sport &gt; Mats</g:product_type>");
    expect(xml).toContain("<g:custom_label_0>sale</g:custom_label_0>");
    expect(xml).toContain("<g:condition>new</g:condition>");
  });

  it("sets item_group_id only for products with several variants", () => {
    expect(xml.match(/<g:item_group_id>p-1<\/g:item_group_id>/g)).toHaveLength(2);
    expect(xml).not.toContain("<g:item_group_id>p-2</g:item_group_id>");
  });

  it("escapes &, <, > and quotes", () => {
    expect(xml).toContain("<title>Mat &quot;Pro&quot; &lt;XL&gt; &amp; more&apos;s </title>");
    expect(xml).toContain("<g:brand>A&amp;B &lt;Co&gt;</g:brand>");
    expect(xml).toContain("<link>https://shop.example/mat/?a=1&amp;b=2</link>");
  });
});

describe("renderHeureka", () => {
  const xml = renderHeureka(variants, { deliveryDaysNotInStock: 14 });

  it("is well-formed with SHOP root and one SHOPITEM per item", () => {
    assertWellFormedXml(xml);
    expect(xml).toContain("\n<SHOP>\n");
    expect(xml.match(/<SHOPITEM>/g)).toHaveLength(3);
  });

  it("emits the price the customer pays without currency", () => {
    expect(xml).toContain("<ITEM_ID>V-RED</ITEM_ID>");
    expect(xml).toContain("<PRICE_VAT>19.90</PRICE_VAT>");
    expect(xml).toContain("<CATEGORYTEXT>Sport | Mats</CATEGORYTEXT>");
    expect(xml).toContain("<ITEMGROUP_ID>p-1</ITEMGROUP_ID>");
    expect(xml).toContain("<EAN>4006381333931</EAN>");
  });

  it("maps availability to DELIVERY_DATE", () => {
    const red = xml.slice(xml.indexOf("V-RED"), xml.indexOf("V-BLUE"));
    expect(red).toContain("<DELIVERY_DATE>0</DELIVERY_DATE>");
    const blue = xml.slice(xml.indexOf("V-BLUE"), xml.indexOf("NASTY-1"));
    expect(blue).toContain("<DELIVERY_DATE>14</DELIVERY_DATE>");
    expect(renderHeureka([item({ availability: "preorder" })])).not.toContain("DELIVERY_DATE");
  });

  it("escapes &, <, > and quotes", () => {
    expect(xml).toContain("<PRODUCTNAME>Mat &quot;Pro&quot; &lt;XL&gt; &amp; more&apos;s </PRODUCTNAME>");
    expect(xml).toContain("<MANUFACTURER>A&amp;B &lt;Co&gt;</MANUFACTURER>");
    expect(xml).toContain("<CATEGORYTEXT>Sport &amp; Fun | Mats &lt;new&gt;</CATEGORYTEXT>");
  });
});

describe("renderZbozi", () => {
  const xml = renderZbozi(variants);

  it("is well-formed with the Zbozi namespace on SHOP", () => {
    assertWellFormedXml(xml);
    expect(xml).toContain('<SHOP xmlns="http://www.zbozi.cz/ns/offer/1.0">');
    expect(xml.match(/<SHOPITEM>/g)).toHaveLength(3);
  });

  it("emits PRODUCTNO, BRAND and truncates long names", () => {
    expect(xml).toContain("<PRODUCTNO>V-RED</PRODUCTNO>");
    expect(xml).toContain("<BRAND>ExampleBrand</BRAND>");
    const long = renderZbozi([item({ title: "x".repeat(300) })]);
    expect(long).toContain(`<PRODUCTNAME>${"x".repeat(255)}</PRODUCTNAME>`);
  });

  it("escapes &, <, > and quotes", () => {
    expect(xml).toContain("<PRODUCT>Mat &quot;Pro&quot; &lt;XL&gt; &amp; more&apos;s </PRODUCT>");
  });
});

describe("comparisonItemId", () => {
  it("replaces characters Heureka and Zbozi do not allow", () => {
    expect(comparisonItemId("AB/12 x")).toBe("AB-12-x");
    expect(comparisonItemId("x".repeat(40))).toHaveLength(36);
  });
});

describe("assertWellFormedXml (test helper)", () => {
  it.each([
    ["bare ampersand", "<a>x & y</a>"],
    ["raw less-than", "<a>x < y</a>"],
    ["mismatched tags", "<a><b></a></b>"],
    ["unclosed tag", "<a><b></b>"],
    ["two roots", "<a></a><b></b>"],
  ])("rejects %s", (_why, xml) => {
    expect(() => assertWellFormedXml(xml)).toThrow();
  });
});
