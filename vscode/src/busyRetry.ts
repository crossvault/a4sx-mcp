// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 crossVault GmbH
// #2309 (cell01, during a deploy): after the server came back, My sessions and Launch profiles kept showing "a4sx is
// busy right now…" for minutes, with no retry. A view that got a busy answer (429/503) reads again by itself: after
// the server's Retry-After when it sent one, else after a growing wait (5 s, 10 s, 20 s, 40 s, then every 60 s), and
// stops once a read succeeds or the view is refreshed by hand.

export const BUSY_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];

export class BusyRetry {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tries = 0;

  constructor(private readonly reread: () => void, private readonly backoff: readonly number[] = BUSY_BACKOFF_MS,
    private readonly maxTries = Infinity) {}

  /** A busy answer: read again later (once; a later busy answer schedules the next one). */
  busy(retryAfterMs?: number): void {
    this.clearTimer();
    if (this.tries >= this.maxTries) {
      return;   // given up: the view's own Refresh tries again
    }
    const step = this.backoff[Math.min(this.tries, this.backoff.length - 1)];
    this.tries++;
    const wait = retryAfterMs !== undefined ? Math.max(retryAfterMs, 1_000) : step;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reread();
    }, wait);
  }

  /** A read that wasn't busy (it worked, or failed in another way): no more retries, and the back-off starts over. */
  settled(): void {
    this.clearTimer();
    this.tries = 0;
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
