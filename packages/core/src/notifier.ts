import type { FlexiConfig, SlackChannel } from "./config.js";
import type { Logger } from "./logger.js";
import { log as defaultLog } from "./logger.js";

export interface NotifyOptions {
  /** Slack Block Kit blocks. `text` stays the fallback for notifications. */
  blocks?: unknown[];
}

export interface NotifyResult {
  /** true only when Slack accepted the message. */
  delivered: boolean;
}

export interface Notifier {
  notify(channel: SlackChannel, text: string, opts?: NotifyOptions): Promise<NotifyResult>;
  isConfigured(channel: SlackChannel): boolean;
}

export interface NotifierOptions {
  fetch?: typeof fetch;
  log?: Logger;
  timeoutMs?: number;
}

/**
 * Posts to the Slack incoming webhook of a logical channel. Without a webhook
 * the message is logged instead. Never throws: a notification failure is
 * logged and reported as `delivered: false`, so it cannot break the task.
 */
export function createNotifier(config: Pick<FlexiConfig, "slack">, options: NotifierOptions = {}): Notifier {
  const doFetch = options.fetch ?? globalThis.fetch;
  const log = options.log ?? defaultLog;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    isConfigured: (channel) => Boolean(config.slack[channel]),
    async notify(channel, text, opts = {}) {
      const webhook = config.slack[channel];
      if (!webhook) {
        log.info("notification (no Slack webhook configured)", { channel, text });
        return { delivered: false };
      }
      try {
        const response = await doFetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(opts.blocks ? { text, blocks: opts.blocks } : { text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          log.error("Slack notification failed", { channel, status: response.status, body: body.slice(0, 200), text });
          return { delivered: false };
        }
        return { delivered: true };
      } catch (err) {
        log.error("Slack notification failed", {
          channel,
          error: err instanceof Error ? err.message : String(err),
          text,
        });
        return { delivered: false };
      }
    },
  };
}
