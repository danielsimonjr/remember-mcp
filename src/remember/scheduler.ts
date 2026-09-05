/**
 * Background scheduler for automatic memory archival.
 */

import type { RememberSystem } from "./system.ts";

export class ArchivalScheduler {
  readonly system: RememberSystem;
  interval: number;
  enabled: boolean;
  running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  last_run: number | null = null;
  total_archived = 0;
  last_error: string | null = null;

  constructor(
    rememberSystem: RememberSystem,
    intervalSeconds = 86_400,
    enabled = true,
  ) {
    if (intervalSeconds < 1) throw new Error("interval_seconds must be >= 1");
    this.system = rememberSystem;
    this.interval = intervalSeconds;
    this.enabled = enabled;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.enabled = true;
    this.running = true;
    this._scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private _scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this._tick();
    }, delayMs);
  }

  private async _tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this._runArchival();
      this._scheduleNext(this.interval * 1000);
    } catch (err) {
      this.last_error = err instanceof Error ? err.message : String(err);
      this._scheduleNext(60_000);
    }
  }

  private async _runArchival(): Promise<void> {
    if (!this.enabled) return;
    try {
      const stats = await this.system.archiveOldMemories({
        age_days: this.system.archiveThresholdDays,
        min_salience: this.system.archiveMinSalience,
      });
      this.last_run = Date.now();
      this.total_archived += stats.archived_count;
      this.last_error = null;
    } catch (err) {
      this.last_error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async runNow(): Promise<void> {
    await this._runArchival();
  }

  getStatus(): Record<string, unknown> {
    return {
      running: this.running,
      enabled: this.enabled,
      interval_seconds: this.interval,
      last_run: this.last_run,
      total_archived: this.total_archived,
      next_run_in: this._timeUntilNextRun(),
      last_error: this.last_error,
    };
  }

  private _timeUntilNextRun(): number | null {
    if (!this.running || this.last_run === null) return null;
    const elapsed = Date.now() - this.last_run;
    const remaining = this.interval * 1000 - elapsed;
    return Math.max(0, Math.floor(remaining / 1000));
  }
}
