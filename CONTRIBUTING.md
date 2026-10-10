# Contributing to flexi

flexi started as the internal system of one company running five Shoptet stores. It gets
better when other merchants and agencies add what they built for their own shops.

## Three ways to contribute

1. **A skill** (easiest). One folder in `skills/` with one `SKILL.md`. It teaches Claude Code
   how to do a Shoptet task well: triaging stuck orders, writing product copy for five
   languages, checking a feed before a campaign. No code required.
2. **A module.** One folder in `modules/` that adds a capability (a feed format, a carrier, a
   bank, an alert). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#module-contract) for the
   contract and copy `modules/stuck-orders` as a starting point.
3. **Fixes and docs.** Bugs, clearer setup steps, translations.

## Before you open a pull request

- `npm test` and `npm run typecheck` pass.
- `npm run secrets:scan` is clean.
- Fixtures are synthetic. No real customers, IBANs, tokens, store IDs or supplier names, even
  from your own shop.
- Nothing merchant specific is hardcoded. Read it from env or from a table.
- The module respects Shoptet API limits (the shared client does this for you).
- English in code and docs. Czech goes to `README.cs.md` and `docs/cs/`.

## Skill template

```markdown
---
name: shoptet-<what-it-does>
description: One sentence. When should Claude use this skill?
---

# <Title>

## When to use
## Steps
## Pitfalls
## Example
```

## Expectations

flexi is maintained by a small team that also runs a business. Reviews may take a few days.
Small, focused pull requests get merged fastest.
