import { closePool, ConfigError, createLogger, type Env } from "@flexity/core";
import { parseArgs } from "./args.js";
import { doctor, list, migrate, run, type CliDeps } from "./commands.js";

export const USAGE = `Usage: flexi <command> [options]

Commands:
  doctor                         Check configuration, database, Slack and installed modules.
  migrate                        Apply core and module SQL migrations.
  list                           List installed modules and their tasks.
  run <module>:<task> [--k=v]    Run one task. Options are passed to the task as ctx.args.

Configuration comes from environment variables. See docs/ARCHITECTURE.md.`;

export async function main(argv: readonly string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = {
    env: process.env as Env,
    out: (line) => void process.stdout.write(line + "\n"),
    log: createLogger({ app: "flexi" }),
    ...overrides,
  };

  try {
    const args = parseArgs(argv);
    if (args.help || args.command === null || args.command === "help") {
      deps.out(USAGE);
      return args.command === null && !args.help ? 1 : 0;
    }
    if (args.command !== "run") {
      const extra = args.positionals[0] ?? Object.keys(args.options)[0];
      if (extra !== undefined) throw new Error(`"flexi ${args.command}" takes no arguments (got "${extra}").`);
    }
    switch (args.command) {
      case "doctor":
        return await doctor(deps);
      case "list":
        return await list(deps);
      case "migrate":
        return await migrate(deps);
      case "run":
        return await run(deps, args);
      default:
        deps.out(USAGE);
        throw new Error(`Unknown command "${args.command}".`);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nRun \`flexi doctor\` for a full report.\n`);
    } else {
      deps.log.error(err instanceof Error ? err.message : String(err));
    }
    return 1;
  } finally {
    await closePool();
  }
}
