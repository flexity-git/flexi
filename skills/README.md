# flexi skills

Claude Code skills for running Shoptet stores with flexi. Each skill is one folder with one
`SKILL.md`. Claude loads a skill when its `description` matches the task, so the
description says when to use it, not what it is.

Install them with the flexi plugin (`.claude-plugin/plugin.json`), or copy a folder into
`~/.claude/skills/` to use one on its own.

| Skill | Use it when |
|---|---|
| [shoptet-api](shoptet-api/SKILL.md) | Writing or debugging code that calls the Shoptet Private API: tokens, rate limits, pagination, incremental sync, timestamps, webhooks. |
| [flexi-setup](flexi-setup/SKILL.md) | Installing flexi for a merchant, running `doctor` and `migrate`, scheduling tasks, verifying the first sync, connecting the MCP server. |
| [flexi-module-author](flexi-module-author/SKILL.md) | Building or reviewing a flexi module: contract, migrations, scopes, tasks, synthetic tests, PR checklist. |
| [shoptet-stuck-orders-triage](shoptet-stuck-orders-triage/SKILL.md) | An order seems stuck in a status, a stuck-orders alert fired, or a customer asks where their order is. |
| [shoptet-feed-preflight](shoptet-feed-preflight/SKILL.md) | Before a campaign that depends on a product feed, or when feed items or approvals drop. |
| [shoptet-multistore-consistency](shoptet-multistore-consistency/SKILL.md) | One catalog on several Shoptet stores: comparing and fixing prices, availability and visibility across them. |
| [shoptet-storefront-html-pitfalls](shoptet-storefront-html-pitfalls/SKILL.md) | Editing HTML in descriptions or blocks, content disappearing after save, importing redirects, reading SEO crawl errors. |
| [mcp-data-safety](mcp-data-safety/SKILL.md) | Querying or changing data through the flexi MCP server. |

## Contributing a skill

A skill is the easiest way to contribute: no code, just what you learned running a shop.

1. Create `skills/<name>/SKILL.md`. Use `shoptet-<what-it-does>` for Shoptet know-how and
   `flexi-<what>` for working on flexi itself.
2. Start with YAML frontmatter:

   ```markdown
   ---
   name: shoptet-<what-it-does>
   description: One or two sentences. When should Claude use this skill?
   ---
   ```

3. Follow the template in [CONTRIBUTING.md](../CONTRIBUTING.md#skill-template):
   When to use, Steps, Pitfalls, Example.
4. Keep it practical and short (roughly 60 to 150 lines). Concrete checks and commands beat
   general advice. Write down the trap that cost you a day, not what the docs already say.
5. Rules:
   - English, no em dashes.
   - Link to https://developers.shoptet.com/ instead of copying Shoptet documentation.
   - No real store domains, customer names, supplier names, tokens or internal hosts.
     Use `shop.example` and `Jane Example`.
   - Do not describe flexi features that do not exist. When unsure, write it as guidance
     ("check that...") rather than as a feature ("flexi does...").
   - Never tell Claude to promise customers dates or outcomes that are not confirmed.
6. Add a row to the table above and run `npm run secrets:scan` before opening the PR.
