# @flexity/cli

The `flexi` command. Run it from the repository root with `npm run flexi -- <command>`
or `npx tsx packages/cli/src/bin.ts <command>`.

| Command | What it does |
|---|---|
| `flexi doctor` | Validates configuration, lists store keys, checks the database, shows which Slack channels are configured and which modules are installed. Never prints tokens or URLs with credentials. Exit code 1 when something is wrong. |
| `flexi migrate` | Applies core migrations, then module migrations in `FLEXI_MODULES` order. Needs `FLEXI_DATABASE_URL`. |
| `flexi list` | Lists installed modules and their tasks. |
| `flexi run <module>:<task> [--key=value ...]` | Runs one task. Options reach the task as `ctx.args` (`--flag` alone is `true`). The run is recorded in `flexi_task_runs`. Prints a JSON result line to stdout and exits 1 on failure. |

Logs are JSON lines on stderr; command output goes to stdout.

## Module discovery

The CLI looks for `node_modules/@flexity` in the working directory, in its own
location and in their parent directories, and loads every package named
`@flexity/module-<name>`. npm workspaces link each package under `modules/` there, so a
new module is picked up after `npm install`. The same lookup finds modules installed from
npm. The package's default export must be a `defineModule()` manifest whose `name` equals
`<name>`. With `FLEXI_MODULES` set, only those modules are loaded, in that order, and a
listed module that is not installed is an error.

## Shoptet clients

`ctx.shoptet(storeKey)` creates one client per store with `createShoptetClient({ token })`
from `@flexity/shoptet`. The package is imported at runtime, so a task that does not use
Shoptet still runs when the client package is missing.
