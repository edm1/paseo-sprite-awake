import type { AwakeMode } from "../shared/settings.ts";
import type { TimerPort } from "./awake-manager.ts";

export interface ActivityWindows {
  interactionUntil: number | null;
}
export interface UserActivityOptions {
  timers?: TimerPort;
  onChange: (windows: ActivityWindows) => void;
}

/** Finite windows, advanced only by explicit activity, never by a connection or poll. */
export class UserActivity {
  private readonly timers: TimerPort;
  private readonly onChange: UserActivityOptions["onChange"];
  private timer: unknown | null = null;
  private mode: AwakeMode = "auto";
  private interactionMinutes = 10;
  private lastInteraction: number | null = null;
  private stopped = false;

  constructor(options: UserActivityOptions) {
    this.onChange = options.onChange;
    this.timers = options.timers ?? {
      now: Date.now,
      setTimeout: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        timer.unref?.();
        return timer;
      },
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  configure(mode: AwakeMode, interactionMinutes: number): void {
    if (this.stopped) return;
    if (!Number.isInteger(interactionMinutes) || interactionMinutes < 0 || interactionMinutes > 60) throw new Error("Invalid activity timeout");
    if (this.windows().interactionUntil === null) this.lastInteraction = null;
    this.mode = mode;
    this.interactionMinutes = interactionMinutes;
    if (mode === "off" || interactionMinutes === 0) this.lastInteraction = null;
    this.publish();
  }

  note(): void {
    if (this.stopped || this.mode === "off" || this.interactionMinutes === 0) return;
    this.lastInteraction = this.timers.now();
    this.publish();
  }

  windows(): ActivityWindows {
    if (this.mode === "off" || this.stopped || this.lastInteraction === null || this.interactionMinutes === 0) return { interactionUntil: null };
    const until = this.lastInteraction + this.interactionMinutes * 60_000;
    return { interactionUntil: until > this.timers.now() ? until : null };
  }

  cleanup(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.lastInteraction = null;
  }

  private publish(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const windows = this.windows();
    if (windows.interactionUntil === null) this.lastInteraction = null;
    else this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.publish();
    }, windows.interactionUntil - this.timers.now());
    this.onChange(windows);
  }
}
