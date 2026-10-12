import type { AwakeMode } from "../shared/settings.ts";
import {
  DEFAULT_HEARTBEAT_MS,
  type SpriteTaskPort,
} from "./sprite-api.ts";

export const DEFAULT_GRACE_MS = 60_000;
export const DEFAULT_RETRY_BASE_MS = 5_000;
export const DEFAULT_RETRY_MAX_MS = 60_000;

export type IntegrationState = "checking" | "available" | "unavailable" | "error";
export type AwakeState = "checking" | "working" | "grace" | "idle" | "always" | "off" | "unavailable" | "error";

export interface AwakeStatus {
  mode: AwakeMode;
  state: AwakeState;
  activeAgents: number;
  taskConfirmed: boolean;
  lastHeartbeat: string | null;
  error: string | null;
}

export interface TimerPort {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const systemTimers: TimerPort = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface AwakeManagerOptions {
  tasks: SpriteTaskPort;
  taskName: string;
  heartbeatMs?: number;
  graceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  timers?: TimerPort;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  onStatusChange?: () => void;
}

export class AwakeManager {
  private readonly tasks: SpriteTaskPort;
  private readonly taskName: string;
  private readonly heartbeatMs: number;
  private readonly graceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly timers: TimerPort;
  private readonly log: NonNullable<AwakeManagerOptions["log"]>;
  private readonly onStatusChange: (() => void) | undefined;

  private mode: AwakeMode = "auto";
  private settingsReady = false;
  private activeAgents = 0;
  private initialReconciliationDone = false;
  private integration: IntegrationState = "checking";
  private integrationError: string | null = null;
  private agentReconciliationError: string | null = null;
  private confirmed = false;
  private taskMayExist = false;
  private lastHeartbeatAt: number | null = null;
  private lastError: string | null = null;
  private loggedError: string | null = null;
  private failures = 0;
  private graceActive = false;
  private stopped = false;
  private heartbeatTimer: unknown | null = null;
  private graceTimer: unknown | null = null;
  private retryTimer: unknown | null = null;
  private syncPromise: Promise<void> | null = null;
  private syncTarget: boolean | null = null;
  private syncAgain = false;
  private forceAgain = false;

  constructor(options: AwakeManagerOptions) {
    this.tasks = options.tasks;
    this.taskName = options.taskName;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.timers = options.timers ?? systemTimers;
    this.log = options.log ?? ((level, message) => {
      if (level === "error") console.error(message);
      else if (level === "warn") console.warn(message);
      else console.log(message);
    });
    this.onStatusChange = options.onStatusChange;
  }

  setIntegration(state: IntegrationState, diagnostic: string | null = null, taskExists = false): void {
    if (this.stopped) return;
    this.integration = state;
    this.integrationError = state === "error" ? diagnostic : null;
    if (state === "available") {
      this.taskMayExist = taskExists;
      this.confirmed = taskExists;
      this.clearError();
    } else {
      this.confirmed = false;
    }
    this.onStatusChange?.();
    this.requestSync(state === "available" && this.wantsHold());
  }

  setMode(mode: AwakeMode): void {
    if (this.stopped) return;
    const changed = this.mode !== mode;
    this.mode = mode;
    this.settingsReady = true;
    if (mode !== "auto") this.cancelGrace();
    this.onStatusChange?.();
    this.requestSync(changed && (mode === "always" || this.wantsHold()));
  }

  setActiveAgentCount(count: number): void {
    if (this.stopped) return;
    const next = Math.max(0, Math.floor(count));
    const previous = this.activeAgents;
    this.activeAgents = next;

    if (next > 0) {
      this.cancelGrace();
      this.requestSync(previous === 0 || !this.confirmed);
    } else if (previous > 0 && this.mode === "auto" && this.initialReconciliationDone) {
      this.beginGrace();
    } else {
      this.requestSync(false);
    }
    this.onStatusChange?.();
  }

  /** Force an upsert when a new turn begins, even if a hold is already active. */
  ensureNow(): void {
    if (this.stopped) return;
    this.requestSync(true);
  }

  finishInitialReconciliation(): void {
    if (this.stopped) return;
    if (this.initialReconciliationDone) return;
    this.initialReconciliationDone = true;
    if (this.mode === "auto" && this.activeAgents === 0) this.cancelGrace();
    this.requestSync(this.wantsHold() && !this.confirmed);
    this.onStatusChange?.();
  }

  setIntegrationError(diagnostic: string): void {
    if (this.stopped) return;
    this.integration = "error";
    this.integrationError = diagnostic;
    this.confirmed = false;
    this.reportError(diagnostic);
    this.onStatusChange?.();
  }

  setAgentReconciliationError(diagnostic: string): void {
    if (this.stopped) return;
    this.agentReconciliationError = diagnostic;
    this.onStatusChange?.();
  }

  clearAgentReconciliationError(): void {
    if (this.stopped || this.agentReconciliationError === null) return;
    this.agentReconciliationError = null;
    this.onStatusChange?.();
  }

  getStatus(): AwakeStatus {
    const error = this.integration === "error"
      ? this.integrationError
      : this.agentReconciliationError ?? this.lastError;
    let state: AwakeState;

    if (this.integration === "unavailable") state = "unavailable";
    else if (this.integration === "error" || this.agentReconciliationError || this.lastError) state = "error";
    else if (this.integration === "checking" || !this.settingsReady || (this.mode === "auto" && !this.initialReconciliationDone)) state = "checking";
    else if (this.wantsHold() && !this.confirmed) state = "checking";
    else if (this.mode === "always" && this.confirmed) state = "always";
    else if (this.activeAgents > 0 && this.confirmed) state = "working";
    else if (this.graceActive && this.confirmed) state = "grace";
    else if (this.mode === "off" && !this.confirmed) state = "off";
    else if (!this.confirmed && !this.taskMayExist) state = "idle";
    else state = "checking";

    return {
      mode: this.mode,
      state,
      activeAgents: this.activeAgents,
      taskConfirmed: this.confirmed,
      lastHeartbeat: this.lastHeartbeatAt === null ? null : new Date(this.lastHeartbeatAt).toISOString(),
      error,
    };
  }

  /** Wait for current task synchronisation; requests have a bounded transport deadline. */
  async waitForCurrentSync(): Promise<void> {
    while (this.syncPromise) await this.syncPromise;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelGrace();
    this.clearTimer("heartbeat");
    this.clearTimer("retry");
    this.syncAgain = false;

    // Let a bounded in-flight request finish before deleting, so a late PUT
    // cannot recreate the task after cleanup.
    if (this.syncPromise) await this.syncPromise.catch(() => undefined);
    // A failed or still-pending startup inspection cannot prove that an older
    // owned task is absent. Try the idempotent local DELETE unless detection
    // positively identified an unsupported host.
    if (this.integration === "unavailable") return;
    if (this.integration === "available" && !this.taskMayExist && !this.confirmed) return;
    try {
      await this.tasks.deleteTask(this.taskName);
      this.confirmed = false;
      this.taskMayExist = false;
      this.log("info", "Sprite keep-awake task released during plugin shutdown");
    } catch (error) {
      this.log("warn", `Could not release the Sprite keep-awake task during shutdown: ${errorMessage(error)}`);
    }
  }

  private wantsHold(): boolean {
    if (this.mode === "always") return true;
    if (this.mode === "off") return false;
    return this.activeAgents > 0 || this.graceActive;
  }

  private mayDelete(): boolean {
    if (this.mode === "off" || this.mode === "always") return true;
    return this.initialReconciliationDone;
  }

  private beginGrace(): void {
    this.cancelGrace();
    this.graceActive = true;
    this.requestSync(false);
    this.graceTimer = this.timers.setTimeout(() => {
      this.graceTimer = null;
      this.graceActive = false;
      this.requestSync(false);
      this.onStatusChange?.();
    }, this.graceMs);
  }

  private cancelGrace(): void {
    if (this.graceTimer !== null) this.timers.clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.graceActive = false;
  }

  private requestSync(force: boolean): void {
    if (this.stopped || !this.settingsReady || this.integration !== "available") return;
    if (!this.wantsHold() && !this.mayDelete()) return;
    if (this.syncPromise) {
      const target = this.wantsHold();
      if (target !== this.syncTarget || (force && target && this.confirmed)) {
        this.syncAgain = true;
        this.forceAgain ||= force;
      }
      return;
    }

    this.syncTarget = this.wantsHold();
    this.syncPromise = this.runSync(force).finally(() => {
      this.syncPromise = null;
      this.syncTarget = null;
      if (this.syncAgain && !this.stopped) {
        const nextForce = this.forceAgain;
        this.syncAgain = false;
        this.forceAgain = false;
        this.requestSync(nextForce);
      }
    });
  }

  private async runSync(force: boolean): Promise<void> {
    const wantHold = this.wantsHold();
    try {
      if (wantHold) {
        if (this.confirmed && !force) return;
        const wasConfirmed = this.confirmed;
        // The server may commit a PUT even if its response is lost. Remember
        // that possibility so an eventual release attempts DELETE as well.
        this.taskMayExist = true;
        await this.tasks.upsertTask(this.taskName);
        this.confirmed = true;
        this.taskMayExist = true;
        this.lastHeartbeatAt = this.timers.now();
        this.failures = 0;
        this.clearError();
        this.clearTimer("retry");
        this.scheduleHeartbeat();
        if (!wasConfirmed) this.log("info", `Sprite keep-awake task confirmed (${this.taskName})`);
      } else {
        this.clearTimer("heartbeat");
        if (!this.taskMayExist && !this.confirmed) return;
        await this.tasks.deleteTask(this.taskName);
        this.confirmed = false;
        this.taskMayExist = false;
        this.lastHeartbeatAt = null;
        this.failures = 0;
        this.clearError();
        this.clearTimer("retry");
        this.log("info", `Sprite keep-awake task released (${this.taskName})`);
      }
    } catch (error) {
      const message = `Sprite keep-awake ${wantHold ? "renewal" : "release"} failed: ${errorMessage(error)}`;
      this.reportError(message);
      this.failures += 1;
      if (wantHold) this.confirmed = false;
      this.scheduleRetry();
    } finally {
      this.onStatusChange?.();
      if (!this.stopped && wantHold !== this.wantsHold()) {
        this.syncAgain = true;
        this.forceAgain = false;
      }
    }
  }

  private scheduleHeartbeat(): void {
    this.clearTimer("heartbeat");
    if (!this.wantsHold() || this.stopped) return;
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null;
      this.requestSync(true);
    }, this.heartbeatMs);
  }

  private scheduleRetry(): void {
    this.clearTimer("retry");
    if (this.stopped) return;
    const delay = Math.min(this.retryBaseMs * 2 ** Math.min(this.failures - 1, 10), this.retryMaxMs);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.requestSync(true);
    }, delay);
  }

  private clearTimer(kind: "heartbeat" | "grace" | "retry"): void {
    const key = `${kind}Timer` as const;
    const timer = this[key];
    if (timer !== null) this.timers.clearTimeout(timer);
    this[key] = null;
  }

  private clearError(): void {
    const hadError = this.lastError !== null;
    this.lastError = null;
    if (hadError && this.loggedError) {
      this.log("info", "Sprite Tasks API recovered; keep-awake management is healthy again");
    }
    this.loggedError = null;
  }

  private reportError(message: string): void {
    this.lastError = message;
    if (this.loggedError !== message) {
      this.log("error", message);
      this.loggedError = message;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
