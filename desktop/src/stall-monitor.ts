/**
 * Simplified main-event-loop stall monitor.
 *
 * A 200 ms timer records the expected next tick. When it fires late, the
 * overrun is the time the main thread could not service timers. A wall-clock
 * jump much larger than the monotonic gap means the machine was suspended, not
 * that JS was blocked; those samples are marked and not reported as stalls.
 *
 * This is deliberately not a profiler: it gives the log a duration and context
 * without retaining stacks or starting an inspector.
 */

export interface StallSample {
  readonly durationMs: number;
  readonly wallJumpMs: number;
  readonly suspended: boolean;
}

export interface StallMonitorOptions {
  readonly intervalMs?: number;
  readonly thresholdMs?: number;
  readonly now?: () => number;
  readonly wall?: () => number;
}

export class StallMonitor {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private readonly wall: () => number;
  private expected: number;
  private lastWall: number;
  private lastMono: number;

  constructor(options: StallMonitorOptions = {}) {
    this.intervalMs = Math.max(50, options.intervalMs ?? 200);
    this.thresholdMs = Math.max(250, options.thresholdMs ?? 1500);
    this.now = options.now ?? (() => performance.now());
    this.wall = options.wall ?? (() => Date.now());
    const mono = this.now();
    this.expected = mono + this.intervalMs;
    this.lastMono = mono;
    this.lastWall = this.wall();
  }

  /** Called by the timer; returns a sample only when the tick was late. */
  tick(): StallSample | null {
    const mono = this.now();
    const wall = this.wall();
    const overrun = mono - this.expected;
    const wallJump = wall - this.lastWall - (mono - this.lastMono);
    this.expected = mono + this.intervalMs;
    this.lastMono = mono;
    this.lastWall = wall;
    if (overrun <= this.thresholdMs) return null;
    return {
      durationMs: Math.round(overrun),
      wallJumpMs: Math.round(Math.max(0, wallJump)),
      suspended: wallJump > this.thresholdMs,
    };
  }
}

export interface StallMonitorHandle {
  stop(): void;
}

export function startStallMonitor(
  options: StallMonitorOptions & { onSample: (sample: StallSample) => void },
): StallMonitorHandle {
  const intervalMs = Math.max(50, options.intervalMs ?? 200);
  const monitor = new StallMonitor({ ...options, intervalMs });
  const timer = setInterval(() => {
    const sample = monitor.tick();
    if (sample) options.onSample(sample);
  }, intervalMs);
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
