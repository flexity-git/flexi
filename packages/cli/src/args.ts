import type { TaskArgs } from "@flexity/core";

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  options: TaskArgs;
  help: boolean;
}

const OPTION_KEY = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Parses `flexi <command> [positionals] [--key=value | --flag]`.
 * Only the `--key=value` form takes a value, so a positional after a flag is
 * never swallowed by accident. `--` ends option parsing.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: TaskArgs = {};
  let help = false;
  let optionsEnded = false;

  for (const arg of argv) {
    if (optionsEnded || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown short option "${arg}". Use --key=value.`);
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (!OPTION_KEY.test(key)) throw new Error(`Invalid option name "--${key}".`);
    if (Object.hasOwn(options, key)) throw new Error(`Option "--${key}" is given more than once.`);
    options[key] = eq === -1 ? true : body.slice(eq + 1);
  }

  const [command = null, ...rest] = positionals;
  return { command, positionals: rest, options, help };
}

/** Splits `module:task`. */
export function parseTarget(target: string | undefined): { module: string; task: string } {
  const match = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/.exec(target ?? "");
  if (!match) throw new Error(`Expected <module>:<task>, e.g. "stuck-orders:check"${target ? `, got "${target}"` : ""}.`);
  return { module: match[1]!, task: match[2]! };
}
