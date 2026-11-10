/**
 * Decouples solver cadence from render cadence (brief section 7: solver at
 * ~5-15 Hz, rendering at native XR rate).
 */
export interface SolveScheduler {
  /** Called every rendered frame; returns true when a solve should run now. */
  shouldSolve(deltaTime: number): boolean;
  /** Time accumulated since the last solve; passed as `LayoutContext.deltaTime`. */
  readonly elapsedSinceSolve: number;
  reset(): void;
}

export class EveryFrameScheduler implements SolveScheduler {
  elapsedSinceSolve = 0;
  shouldSolve(deltaTime: number): boolean {
    this.elapsedSinceSolve = deltaTime;
    return true;
  }
  reset(): void {
    this.elapsedSinceSolve = 0;
  }
}

export class FixedRateScheduler implements SolveScheduler {
  private accumulator = 0;
  private first = true;
  elapsedSinceSolve = 0;

  constructor(private readonly hz = 10) {
    if (!(hz > 0)) throw new RangeError("FixedRateScheduler: hz must be > 0");
  }

  shouldSolve(deltaTime: number): boolean {
    this.accumulator += Math.max(0, deltaTime);
    if (this.first || this.accumulator >= 1 / this.hz) {
      this.first = false;
      this.elapsedSinceSolve = this.accumulator;
      this.accumulator = 0;
      return true;
    }
    return false;
  }

  reset(): void {
    this.accumulator = 0;
    this.first = true;
    this.elapsedSinceSolve = 0;
  }
}
