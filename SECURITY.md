# Security policy

flexi runs with your Shoptet Private API tokens and, optionally, a database full of your
orders. Please treat security reports seriously and privately.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting instead:
**Security > Report a vulnerability** on this repository.

You should get a reply within 7 days. Please include the affected version or commit, steps to
reproduce, and the impact you expect.

## What we consider in scope

- Token or secret leakage (logs, error messages, MCP responses).
- MCP SQL guard bypass, scope escalation, or reading tables that are not allowlisted.
- Write tools changing data without the preview and confirm step.
- Webhook signature verification flaws.

## Running flexi safely

- Create a dedicated Shoptet Private API token for flexi and give it only the endpoint groups
  your enabled modules need.
- Never commit `.env`. Keep tokens in your secret store or deployment environment.
- Give MCP tokens the smallest scope set that works. `data:read:customers` exposes personal
  data and should be rare.
