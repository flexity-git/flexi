export const DEFAULT_MIN_RATIO = 0.7;

export interface BreakerDecision {
  write: boolean;
  reason: string;
}

/**
 * Decides whether a new feed may replace the published one. A sudden drop in
 * item count usually means a broken sync or a bad rule, not a real catalogue
 * change, and publishing it would pull most offers from the merchant center.
 *
 * `previousCount` is the item count of the last run that was actually written,
 * so a blocked run does not lower the bar for the next one.
 */
export function checkBreaker(newCount: number, previousCount: number | null, minRatio = DEFAULT_MIN_RATIO): BreakerDecision {
  if (previousCount === null || previousCount <= 0) {
    if (newCount === 0) return { write: false, reason: "The feed has no items." };
    return { write: true, reason: "No previous run to compare with." };
  }
  const ratio = newCount / previousCount;
  if (ratio < minRatio) {
    return {
      write: false,
      reason: `Item count fell from ${previousCount} to ${newCount} (${Math.round(ratio * 100)}%, minimum ${Math.round(minRatio * 100)}%).`,
    };
  }
  return { write: true, reason: `Item count ${newCount} vs. previous ${previousCount}.` };
}
