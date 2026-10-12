import { AgentTracker, type AgentDirectoryEntry, type AgentSnapshot } from "./agent-tracker.ts";
import type { AwakeManager } from "./awake-manager.ts";

const DIRECTORY_PAGE_SIZE = 100;
const RECONCILE_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 1_000;

interface AgentListPage {
  entries: AgentDirectoryEntry[];
  pageInfo?: { nextCursor?: string | null };
  subscription?: {
    subscribe(handlers: {
      snapshot(snapshot: { entries: AgentDirectoryEntry[] }): void;
      update(message: unknown): void;
      error?(error: unknown): void;
    }): unknown;
    release(): Promise<void>;
  };
}

/** Structural subset of the documented Paseo SDK agent-directory API. */
export interface PaseoAgentPort {
  agents: {
    list(options: {
      filter: { includeArchived: false; includeBackground: true };
      page: { limit: number; cursor?: string };
      subscribe?: Record<string, never>;
    }): Promise<AgentListPage>;
    ref(agentId: string): {
      refresh(): Promise<unknown>;
      current(): AgentSnapshot | null;
    };
  };
}

export interface AgentRuntimeOptions {
  tracker: AgentTracker;
  getManager: () => AwakeManager | null;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

/**
 * Owns the Paseo agent-directory observation and periodic, paged reconciliation.
 * `initialize()` must be called with the documented `context.paseo` SDK from a
 * lifecycle callback or handler; PluginServerContext itself has no SDK client.
 */
export class AgentRuntime {
  private readonly tracker: AgentTracker;
  private readonly getManager: AgentRuntimeOptions["getManager"];
  private readonly log: NonNullable<AgentRuntimeOptions["log"]>;
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private readonly requestTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private api: PaseoAgentPort | null = null;
  private subscription: AgentListPage["subscription"] | null = null;
  private initialization: Promise<void> | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconciled = false;
  private lastLogKey: string | null = null;
  private scanInFlight: Promise<boolean> | null = null;
  /** Last tracker revision known to be represented by directory data. */
  private readonly directoryBaselines = new Map<string, number>();
  private readonly refreshesInFlight = new Set<string>();
  private readonly queuedRefreshes = new Map<string, { api: PaseoAgentPort; turnId: string | null; revision: number }>();

  constructor(options: AgentRuntimeOptions) {
    this.tracker = options.tracker;
    this.getManager = options.getManager;
    this.log = options.log ?? ((level, message) => {
      if (level === "error") console.error(message);
      else if (level === "warn") console.warn(message);
      else console.log(message);
    });
    this.timers = options.timers ?? globalThis;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
  }

  get initialReconciliationComplete(): boolean { return this.reconciled; }

  get activeAgentCount(): number {
    return this.tracker.activeCount;
  }

  initialize(paseo: unknown): void {
    if (this.stopped || this.initialization || (this.subscription && this.reconciled)) return;
    this.api = paseo as PaseoAgentPort;
    this.initialization = this.startDirectoryObservation().finally(() => {
      this.initialization = null;
    });
    void this.initialization.catch(() => undefined);
  }

  turnStarted(agentId: string, turnId: string | null, paseo: unknown): void {
    this.tracker.turnStarted(agentId, turnId);
    this.syncCount(true);
    this.initialize(paseo);
  }

  turnEnded(agentId: string, turnId: string | null, paseo: unknown): void {
    const api = paseo as PaseoAgentPort;
    this.tracker.markEventObserved(agentId);
    const revision = this.tracker.revisionFor(agentId);
    this.initialize(paseo);
    void this.refreshAgent(api, agentId, turnId, revision);
  }

  permissionRequested(agentId: string, requestId: string, paseo: unknown): void {
    this.tracker.permissionRequested(agentId, requestId);
    this.syncCount(false);
    this.initialize(paseo);
  }

  permissionResolved(agentId: string, requestId: string, paseo: unknown): void {
    const api = paseo as PaseoAgentPort;
    this.tracker.permissionResolved(agentId, requestId);
    const revision = this.tracker.revisionFor(agentId);
    this.syncCount(false);
    this.initialize(paseo);
    void this.refreshAgent(api, agentId, null, revision);
  }

  agentClosed(agentId: string, paseo: unknown): void {
    const api = paseo as PaseoAgentPort;
    this.tracker.markEventObserved(agentId);
    const revision = this.tracker.revisionFor(agentId);
    this.initialize(paseo);
    void this.refreshAgent(api, agentId, null, revision);
  }

  agentArchived(agentId: string): void {
    this.tracker.remove(agentId);
    this.syncCount(false);
  }

  async cleanup(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.queuedRefreshes.clear();
    if (this.reconcileTimer) this.timers.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    const pendingCleanup: Promise<unknown>[] = [];
    if (this.subscription) {
      const subscription = this.subscription;
      this.subscription = null;
      pendingCleanup.push(subscription.release().catch((error: unknown) => {
        this.log("warn", `Could not release Paseo agent-directory subscription: ${errorMessage(error)}`);
      }));
    }
    if (this.initialization) pendingCleanup.push(this.initialization.catch(() => undefined));
    if (pendingCleanup.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = await Promise.race([
      Promise.all(pendingCleanup).then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = this.timers.setTimeout(() => resolve(true), this.cleanupTimeoutMs);
      }),
    ]);
    if (timeout) this.timers.clearTimeout(timeout);
    if (timedOut) this.log("warn", "Paseo agent observation cleanup timed out; continuing plugin shutdown");
  }

  private async startDirectoryObservation(): Promise<void> {
    if (!this.api || this.stopped) return;
    const api = this.api;
    try {
      if (!this.subscription) {
        const revisionAtStart = this.tracker.revision;
        const first = await this.waitForRequest(api.agents.list({
          filter: { includeArchived: false, includeBackground: true },
          page: { limit: DIRECTORY_PAGE_SIZE },
          subscribe: {},
        }), (page) => {
          void page.subscription?.release().catch((error: unknown) => {
            this.log("warn", `Could not release late Paseo agent-directory subscription: ${errorMessage(error)}`);
          });
        });
        if (this.stopped) {
          await first.subscription?.release();
          return;
        }
        const subscription = first.subscription ?? null;
        this.subscription = subscription;
        subscription?.subscribe({
          snapshot: (snapshot) => {
            if (this.stopped) return;
            for (const entry of snapshot.entries) {
              if (this.tracker.applySnapshotIfUnchanged(entry.agent, revisionAtStart)) {
                this.rememberDirectoryState(entry.agent.id);
              }
            }
            this.syncCount(false);
          },
          update: (message) => this.applyDirectoryUpdate(message),
          error: (error) => {
            if (this.stopped || this.subscription !== subscription) return;
            this.subscription = null;
            if (subscription) {
              void subscription.release().catch((releaseError: unknown) => {
                this.log("warn", `Could not release failed Paseo agent-directory subscription: ${errorMessage(releaseError)}`);
              });
            }
            this.reportDirectoryError(`Paseo agent-directory subscription failed: ${errorMessage(error)}`);
            this.scheduleReconcile(1_000);
          },
        });
        await this.reconcileFromFirstPage(first, revisionAtStart);
      } else {
        await this.reconcileAllPages();
      }
    } catch (error) {
      this.reportDirectoryError(`Could not reconcile Paseo agent state: ${errorMessage(error)}`);
      this.scheduleReconcile(RECONCILE_INTERVAL_MS);
      return;
    }

    if (this.stopped) return;
    this.clearDirectoryError();
    this.reconciled = true;
    this.getManager()?.finishInitialReconciliation();
    this.scheduleReconcile(RECONCILE_INTERVAL_MS);
  }

  private async reconcileFromFirstPage(first: AgentListPage, revisionAtStart: number): Promise<void> {
    const api = this.api;
    if (!api) return;
    const entries = [...first.entries];
    let cursor = first.pageInfo?.nextCursor ?? undefined;
    const seenCursors = new Set<string>();

    while (cursor && !this.stopped) {
      if (seenCursors.has(cursor)) throw new Error("Paseo agent pagination returned a repeated cursor");
      seenCursors.add(cursor);
      const page = await this.waitForRequest(api.agents.list({
        filter: { includeArchived: false, includeBackground: true },
        page: { limit: DIRECTORY_PAGE_SIZE, cursor },
      }));
      entries.push(...page.entries);
      cursor = page.pageInfo?.nextCursor ?? undefined;
    }

    if (!this.stopped) {
      const applied = this.tracker.applyFullSnapshot(entries, revisionAtStart);
      for (const agentId of applied) this.rememberDirectoryState(agentId);
      this.syncCount(false);
    }
  }

  private async reconcileAllPages(): Promise<boolean> {
    if (this.scanInFlight) return this.scanInFlight;
    const api = this.api;
    if (!api || this.stopped) return false;
    const scan = this.scanPages(api);
    this.scanInFlight = scan;
    try {
      return await scan;
    } finally {
      if (this.scanInFlight === scan) this.scanInFlight = null;
    }
  }

  private async scanPages(api: PaseoAgentPort): Promise<boolean> {
    const revisionAtStart = this.tracker.revision;
    const entries: AgentDirectoryEntry[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    do {
      const page = await this.waitForRequest(api.agents.list({
        filter: { includeArchived: false, includeBackground: true },
        page: { limit: DIRECTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      }));
      entries.push(...page.entries);
      cursor = page.pageInfo?.nextCursor ?? undefined;
      if (cursor && seenCursors.has(cursor)) throw new Error("Paseo agent pagination returned a repeated cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor && !this.stopped);

    if (this.stopped) return false;
    const applied = this.tracker.applyFullSnapshot(entries, revisionAtStart);
    for (const agentId of applied) this.rememberDirectoryState(agentId);
    this.syncCount(false);
    return true;
  }

  private applyDirectoryUpdate(message: unknown): void {
    if (this.stopped) return;
    if (!isRecord(message) || message.type !== "agent_update" || !isRecord(message.payload)) return;
    const payload = message.payload;
    if (payload.kind === "upsert" && isRecord(payload.agent) && typeof payload.agent.id === "string") {
      const snapshot = payload.agent as unknown as AgentSnapshot;
      if (this.directoryUpdateIsCurrent(snapshot.id) && !this.tracker.snapshotMayDiscardWork(snapshot)) {
        this.tracker.applySnapshot(snapshot);
        this.rememberDirectoryState(snapshot.id);
      } else {
        this.refreshIfDirectoryUpdateIsStale(snapshot.id);
      }
    } else if (payload.kind === "remove" && typeof payload.agentId === "string") {
      if (this.directoryUpdateIsCurrent(payload.agentId) && !this.tracker.hasTrackedAgent(payload.agentId)) {
        this.tracker.remove(payload.agentId);
        this.rememberDirectoryState(payload.agentId);
      } else {
        this.refreshIfDirectoryUpdateIsStale(payload.agentId);
      }
    }
    this.syncCount(false);
  }

  private async refreshAgent(
    api: PaseoAgentPort,
    agentId: string,
    endedTurnId: string | null,
    revisionAtRequest: number,
  ): Promise<void> {
    if (this.stopped) return;
    if (this.refreshesInFlight.has(agentId)) {
      this.queuedRefreshes.set(agentId, { api, turnId: endedTurnId, revision: revisionAtRequest });
      return;
    }
    this.refreshesInFlight.add(agentId);
    try {
      const handle = api.agents.ref(agentId);
      await this.waitForRequest(handle.refresh());
      if (this.stopped) return;
      if (this.tracker.applyEndRefresh(agentId, endedTurnId, handle.current(), revisionAtRequest)) {
        this.rememberDirectoryState(agentId);
      }
      this.syncCount(false);
    } catch (error) {
      this.reportDirectoryError(`Could not refresh Paseo agent ${agentId}: ${errorMessage(error)}`);
      // An unknown end state remains active until a later directory update or
      // authoritative scan proves the agent is idle.
    } finally {
      this.refreshesInFlight.delete(agentId);
      const queued = this.queuedRefreshes.get(agentId);
      this.queuedRefreshes.delete(agentId);
      if (queued && !this.stopped) void this.refreshAgent(queued.api, agentId, queued.turnId, queued.revision);
    }
  }

  private directoryUpdateIsCurrent(agentId: string): boolean {
    const lastDirectoryRevision = this.directoryBaselines.get(agentId) ?? 0;
    return this.tracker.revisionFor(agentId) <= lastDirectoryRevision;
  }

  private async waitForRequest<Result>(request: Promise<Result>, onLateResult?: (result: Result) => void): Promise<Result> {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        request.then((result) => {
          if (timedOut) onLateResult?.(result);
          return result;
        }),
        new Promise<Result>((_resolve, reject) => {
          timeout = this.timers.setTimeout(() => {
            timedOut = true;
            reject(new Error(`Paseo SDK request timed out after ${this.requestTimeoutMs} ms`));
          }, this.requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== null) this.timers.clearTimeout(timeout);
    }
  }

  private refreshIfDirectoryUpdateIsStale(agentId: string): void {
    const api = this.api;
    if (!api || this.stopped) return;
    const revision = this.tracker.revisionFor(agentId);
    void this.refreshAgent(api, agentId, null, revision);
  }

  private rememberDirectoryState(agentId: string): void {
    this.directoryBaselines.set(agentId, this.tracker.revisionFor(agentId));
  }

  private syncCount(force: boolean): void {
    const manager = this.getManager();
    manager?.setActiveAgentCount(this.tracker.activeCount);
    if (force && this.tracker.activeCount > 0) manager?.ensureNow();
  }

  private scheduleReconcile(delayMs: number): void {
    if (this.stopped || this.reconcileTimer) return;
    this.reconcileTimer = this.timers.setTimeout(() => {
      this.reconcileTimer = null;
      if (this.stopped) return;
      if (this.subscription) {
        void this.reconcileAllPages().then((success) => {
          if (success) {
            this.clearDirectoryError();
            this.reconciled = true;
            this.getManager()?.finishInitialReconciliation();
            this.scheduleReconcile(RECONCILE_INTERVAL_MS);
          } else {
            this.scheduleReconcile(RECONCILE_INTERVAL_MS);
          }
        }).catch((error: unknown) => {
          this.reportDirectoryError(`Paseo agent reconciliation failed: ${errorMessage(error)}`);
          this.scheduleReconcile(RECONCILE_INTERVAL_MS);
        });
      } else if (this.api) {
        this.initialization = null;
        this.initialize(this.api);
      }
    }, delayMs);
  }

  private reportDirectoryError(message: string): void {
    if (this.stopped) return;
    if (this.lastLogKey !== message) this.log("error", message);
    this.lastLogKey = message;
    this.getManager()?.setAgentReconciliationError(message);
  }

  private clearDirectoryError(): void {
    if (this.lastLogKey) this.log("info", "Paseo agent state reconciliation recovered");
    this.lastLogKey = null;
    this.getManager()?.clearAgentReconciliationError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
