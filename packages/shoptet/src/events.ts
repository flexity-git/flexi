/**
 * Events emitted through the client's `onEvent` hook. Paths never include the
 * query string, because queries can contain customer data such as e-mails.
 */
export type ShoptetEvent =
  | {
      type: "retry";
      method: string;
      path: string;
      /** Attempt that just failed (1-based). */
      attempt: number;
      reason: "server_error" | "locked" | "network";
      status?: number;
      delayMs: number;
    }
  | {
      type: "rate_limited";
      method: string;
      path: string;
      attempt: number;
      /** Raw `Retry-After` header, if any. */
      retryAfter: string | null;
      delayMs: number;
    }
  | {
      type: "throttle";
      method: string;
      path: string;
      /** Value of the leaky-bucket header that triggered a pause. */
      bucketFilling: string;
      delayMs: number;
    }
  | {
      type: "deprecation";
      method: string;
      path: string;
      deprecated: string;
      sunset: string | null;
    }
  | {
      type: "pagination_drift";
      context: string;
      page: number;
      initialTotal: number;
      currentTotal: number;
    }
  | {
      type: "items_per_page_ignored";
      context: string;
      requested: number;
      honoured: number;
    };

export type ShoptetEventHandler = (event: ShoptetEvent) => void;

/** Call a user hook without letting it break the request flow. */
export function safeEmit(handler: ShoptetEventHandler | undefined, event: ShoptetEvent): void {
  if (!handler) return;
  try {
    handler(event);
  } catch {
    // A broken logger must never fail an API call.
  }
}
