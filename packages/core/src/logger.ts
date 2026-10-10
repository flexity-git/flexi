/**
 * Minimal structured logger: one JSON object per line on stderr.
 *
 * stderr keeps stdout free for command output (and for the MCP stdio transport,
 * where anything on stdout would corrupt the protocol).
 */

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every line. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Where lines go. Defaults to process.stderr. */
  write?: (line: string) => void;
  /** Clock, for tests. */
  now?: () => Date;
}

function serializeError(err: Error): LogFields {
  return { name: err.name, message: err.message, stack: err.stack };
}

function normalize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

export function createLogger(bindings: LogFields = {}, options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => void process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    const record = {
      ts: now().toISOString(),
      level,
      msg,
      ...normalize(bindings),
      ...(fields ? normalize(fields) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, msg, note: "fields were not serializable" });
    }
    write(line + "\n");
  };

  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (more) => createLogger({ ...bindings, ...more }, options),
  };
}

/** Process-wide default logger. */
export const log: Logger = createLogger();
