---
name: shoptet-storefront-html-pitfalls
description: Use when writing or editing HTML for a Shoptet storefront (product descriptions, HTML blocks, category texts, banners), when content "disappears" or a layout breaks after saving in the admin, when importing redirects, or when an SEO crawler reports many 500/502 errors on a Shoptet store.
---

# Shoptet storefront HTML pitfalls

What you see in the Shoptet admin editor is not what customers see. The editor rewrites
some HTML on save, the theme adds its own CSS, and some markup is valid but never
rendered. These are the traps that cost the most time.

## When to use

- Preparing HTML for descriptions or HTML blocks, by hand or generated.
- A section, video or text is missing on the live page but present in the admin.
- A grid of cards falls apart after saving.
- Importing or auditing redirects. Reading an SEO crawl report.

## Pitfalls and fixes

### 1. Text between `<iframe>` and `</iframe>` never renders

Browsers treat anything inside an iframe element as fallback content and do not show it.
A missing `</iframe>`, or content pasted after an embed but before its closing tag, hides
everything that follows. This can swallow whole descriptions and further videos without
any visible error.

- Always close every iframe immediately: `<iframe ...></iframe>`, nothing in between.
- Audit: search stored descriptions for `<iframe` and check that the next tag is
  `</iframe>`. Count characters between them; anything above zero is hidden content.

### 2. The editor strips `<a>` wrapped around block elements

`<a href="..."><div class="card">...</div></a>` is valid HTML5, but the admin editor
removes or moves the link on save. Card grids then lose their links or collapse.

- Put the link inside the block: `<div class="card"><a href="..." class="card-link">...</a></div>`.
- For a fully clickable card, make the inner link cover the card with CSS
  (`position: relative` on the card, an absolutely positioned `::after` on the link).
- After saving, reopen the source view and confirm the markup survived.

### 3. The theme draws its own bullets for `<li>`

Most Shoptet themes style `ul li` with their own bullet or icon. Your own `list-style`,
emoji or custom bullet ends up doubled or misaligned.

- Use a class on the list and reset the theme's pseudo-element for that class only.
- Or avoid lists for layout (feature grids, icon rows); use `div`s.

### 4. Verify on the live site, not in the editor

- The editor preview does not load the full theme CSS and scripts.
- Check the live product page on desktop and mobile width, logged out (customer group
  prices and some blocks differ when logged in).
- Check one product per template type you touched (simple product, product with variants).
- `curl -s https://shop.example/product-url/ | grep -c "your-marker"` confirms the content
  is in the delivered HTML, independent of browser cache.

### 5. Redirect imports

- Importing redirects overwrites any existing entry with the same source URL. Export the
  current list first and diff, or you silently replace older redirects.
- Lines starting with `//` are ignored by the import. Commenting out a line is a way to
  skip it, and a source written as `//path` (for example a protocol-relative URL) is
  silently dropped. Count imported entries against lines in the file.
- After import, check redirect targets: a redirect to a page that returns 404 is worse
  than no redirect. Test a sample with `curl -sI -o /dev/null -w "%{http_code} %{redirect_url}\n"`.
- Avoid chains (A to B to C). Point every source to the final URL.

### 6. SEO crawler 500/502 reports

Shoptet throttles aggressive crawlers. A crawl at high speed can produce hundreds of
500/502/503 responses that customers never see.

- Before reporting a server problem, re-check a sample of the reported URLs with curl at
  a normal pace:

  ```sh
  while read -r url; do
    printf "%s %s\n" "$(curl -s -o /dev/null -w "%{http_code}" "$url")" "$url"; sleep 2
  done < reported-urls.txt
  ```

- Only URLs that still fail are real findings. Lower the crawler speed for the next run.

## Example

One store shows suspiciously short descriptions for a whole brand. Source view: each
description starts with a video embed missing `</iframe>`, so the browser hides the text
and three more videos behind it. Fixing the closing tags restores the content; a check
over all descriptions finds the same pattern on other products.
