/**
 * Startup and quit timelines.
 *
 * Both are deliberately dependency-free: the main process records monotonic
 * marks and emits one summary line, so a slow boot or shutdown is diagnosable
 * from `desktop.log` without a profiler. No user content, paths or tokens are
 * recorded.
 */

export interface TimelineMark {
  readonly name: string;
  readonly atMs: number;
  readonly sinceStartMs: number;
  readonly sincePreviousMs: number;
}

export class StartupTimeline {
  private readonly startedAt: number;
  private readonly marks: TimelineMark[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.startedAt = now();
    this.now = now;
  }

  private readonly now: () => number;

  /** Record a named checkpoint; returns it for logging. */
  mark(name: string): TimelineMark {
    const atMs = this.now();
    const previous = this.marks[this.marks.length - 1];
    const mark: TimelineMark = {
      name,
      atMs,
      sinceStartMs: atMs - this.startedAt,
      sincePreviousMs: previous ? atMs - previous.atMs : atMs - this.startedAt,
    };
    this.marks.push(mark);
    return mark;
  }

  summary(): { totalMs: number; marks: readonly TimelineMark[] } {
    const last = this.marks[this.marks.length - 1];
    return {
      totalMs: last ? last.sinceStartMs : this.now() - this.startedAt,
      marks: [...this.marks],
    };
  }
}

export interface QuitPhase {
  readonly name: string;
  readonly durationMs: number;
}

export class QuitTimeline {
  private readonly startedAt: number;
  private readonly phases: QuitPhase[] = [];
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.startedAt = now();
  }

  /** Run one synchronous or asynchronous cleanup phase and time it. */
  async phase<T>(name: string, work: () => T | Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await work();
    } finally {
      this.phases.push({ name, durationMs: this.now() - start });
    }
  }

  /** Record a phase that was already executed. */
  record(name: string, durationMs: number): void {
    this.phases.push({ name, durationMs });
  }

  summary(): {
    durationMs: number;
    phases: readonly QuitPhase[];
    slowest: QuitPhase | null;
  } {
    const phases = [...this.phases];
    let slowest: QuitPhase | null = null;
    for (const phase of phases) {
      if (!slowest || phase.durationMs > slowest.durationMs) slowest = phase;
    }
    return { durationMs: this.now() - this.startedAt, phases, slowest };
  }
}

/** The planned graceful-shutdown budget from the desktop reference. */
export const QUIT_BUDGET_MS = 75_000;
