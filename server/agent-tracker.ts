export interface AgentSnapshot {
  id: string;
  parentAgentId?: string | null;
  archivedAt?: string | null;
  status?: string | null;
  activeTurn?: { turnId?: string | null; startedAt?: string | null } | null;
  pendingPermissions?: readonly { id?: string }[] | null;
}

export interface AgentDirectoryEntry {
  agent: AgentSnapshot;
}

interface ActiveAgent {
  turnId: string | null;
  startedAt: string | null;
  permissions: Set<string>;
  hasTurn: boolean;
  waitingSince: number | null;
}

export interface AgentTrackerOptions {
  onChange?: (activeAgentCount: number) => void;
  now?: () => number;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
}

/**
 * Keeps activity per stable Paseo agent ID. Children are independent entries,
 * so completing a parent never clears a still-running child.
 */
export class AgentTracker {
  private readonly active = new Map<string, ActiveAgent>();
  private readonly mutationVersions = new Map<string, number>();
  private revisionValue = 0;
  private readonly onChange?: AgentTrackerOptions["onChange"];

  private readonly now: () => number;
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private waitingTimeoutMs = 600_000;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AgentTrackerOptions = {}) {
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? globalThis;
  }

  get activeCount(): number {
    return this.activeAgentIds.length;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get activeAgentIds(): string[] {
    const now = this.now();
    return [...this.active].filter(([, agent]) => agent.waitingSince === null ||
      this.waitingTimeoutMs === 0 || now < agent.waitingSince + this.waitingTimeoutMs).map(([id]) => id);
  }

  snapshotMayDiscardWork(snapshot: AgentSnapshot): boolean {
    const prior = this.active.get(snapshot.id);
    if (!prior) return false;
    return Boolean(snapshot.archivedAt) ||
      (prior.hasTurn && (!snapshot.activeTurn || snapshot.activeTurn.turnId !== prior.turnId)) ||
      (prior.waitingSince !== null && snapshot.status !== "permission" && !snapshot.pendingPermissions?.length);
  }

  hasTrackedAgent(agentId: string): boolean {
    return this.active.has(agentId);
  }

  revisionFor(agentId: string): number {
    return this.mutationVersions.get(agentId) ?? 0;
  }

  turnStarted(agentId: string, turnId: string | null): void {
    this.bump(agentId);
    const existing = this.active.get(agentId);
    const duplicate = existing?.hasTurn && turnId !== null && existing.turnId === turnId;
    if (existing && (turnId === null || existing.turnId === turnId)) {
      existing.turnId = turnId ?? existing.turnId;
    } else {
      this.active.set(agentId, {
        turnId,
        hasTurn: true,
        waitingSince: null,
        startedAt: null,
        permissions: existing?.permissions ?? new Set(),
      });
    }
    const current = this.active.get(agentId)!;
    current.hasTurn = true;
    if (!duplicate) {
      current.waitingSince = null;
      current.permissions.clear();
    }
    this.notify();
  }

  permissionRequested(agentId: string, requestId: string): void {
    this.bump(agentId);
    const active = this.active.get(agentId) ?? { turnId: null, hasTurn: false, waitingSince: null, startedAt: null, permissions: new Set<string>() };
    active.permissions.add(requestId);
    active.waitingSince ??= this.now();
    this.active.set(agentId, active);
    this.notify();
  }

  permissionResolved(agentId: string, requestId: string): void {
    this.bump(agentId);
    const active = this.active.get(agentId);
    if (active) {
      active.permissions.delete(requestId);
      if (active.permissions.size === 0) {
        active.waitingSince = null;
        if (!active.hasTurn) this.active.delete(agentId);
      }
    }
    this.notify();
  }

  /** Advance the ordering guard for an event that needs an async snapshot to resolve. */
  markEventObserved(agentId: string): void {
    this.bump(agentId);
  }

  /** Apply a single authoritative Paseo agent snapshot. */
  applySnapshot(snapshot: AgentSnapshot): void {
    this.bump(snapshot.id);
    this.applySnapshotValue(snapshot);
    this.notify();
  }

  /** Apply a snapshot only when no newer local lifecycle event changed the agent. */
  applySnapshotIfUnchanged(snapshot: AgentSnapshot, revisionAtObservationStart: number): boolean {
    if (this.revisionFor(snapshot.id) > revisionAtObservationStart) return false;
    this.bump(snapshot.id);
    this.applySnapshotValue(snapshot);
    this.notify();
    return true;
  }

  /**
   * Applies a completed full-directory scan. Live events received while the
   * paged scan was in flight take precedence over its older snapshots.
   */
  applyFullSnapshot(entries: readonly AgentDirectoryEntry[], revisionAtStart: number): Set<string> {
    const seen = new Set<string>();
    const applied = new Set<string>();
    for (const entry of entries) {
      const snapshot = entry.agent;
      seen.add(snapshot.id);
      if (this.revisionFor(snapshot.id) > revisionAtStart) continue;
      this.bump(snapshot.id);
      this.applySnapshotValue(snapshot);
      applied.add(snapshot.id);
    }

    for (const id of [...this.active.keys()]) {
      if (seen.has(id) || this.revisionFor(id) > revisionAtStart) continue;
      this.bump(id);
      this.active.delete(id);
      applied.add(id);
    }

    for (const [id, version] of this.mutationVersions) {
      if (version <= revisionAtStart && !this.active.has(id)) this.mutationVersions.delete(id);
    }
    this.notify();
    return applied;
  }

  /**
   * Applies a refresh issued for an end/close event only if no newer event for
   * that agent arrived while the SDK request was pending.
   */
  applyEndRefresh(
    agentId: string,
    eventTurnId: string | null,
    snapshot: AgentSnapshot | null,
    revisionAtRequest: number,
  ): boolean {
    if (this.revisionFor(agentId) !== revisionAtRequest) return false;
    if (snapshot && snapshot.id !== agentId) return false;
    this.bump(agentId);
    if (!snapshot || (eventTurnId !== null && snapshot.activeTurn?.turnId === eventTurnId)) {
      if (snapshot) this.applySnapshotValue(snapshot);
      else this.active.delete(agentId);
    } else {
      // A mismatched or nullable event ID may refer to an older turn. The
      // refreshed snapshot, rather than the lifecycle event, is authoritative.
      this.applySnapshotValue(snapshot);
    }
    this.notify();
    return true;
  }

  remove(agentId: string): void {
    this.bump(agentId);
    this.active.delete(agentId);
    this.notify();
  }

  private applySnapshotValue(snapshot: AgentSnapshot): void {
    if (snapshot.archivedAt) {
      this.active.delete(snapshot.id);
      return;
    }

    const prior = this.active.get(snapshot.id);
    const pendingPermissions = snapshot.pendingPermissions ?? [];
    const permissionIds = new Set(
      pendingPermissions.map((request, index) => request.id ?? `snapshot:${index}`),
    );
    const hasPermission = permissionIds.size > 0 || snapshot.status === "permission";
    const hasTurn = snapshot.activeTurn !== null && snapshot.activeTurn !== undefined;

    if (!hasTurn && !hasPermission) {
      this.active.delete(snapshot.id);
      return;
    }

    this.active.set(snapshot.id, {
      hasTurn,
      waitingSince: hasPermission ? (prior?.waitingSince ?? this.now()) : null,
      turnId: hasTurn ? (snapshot.activeTurn?.turnId ?? null) : null,
      startedAt: hasTurn ? (snapshot.activeTurn?.startedAt ?? null) : null,
      permissions: permissionIds,
    });
  }

  private bump(agentId: string): void {
    this.revisionValue += 1;
    this.mutationVersions.set(agentId, this.revisionValue);
  }

  setWaitingTimeoutMinutes(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) throw new Error("Invalid waiting timeout");
    this.waitingTimeoutMs = minutes * 60_000;
    this.notify();
  }

  cleanup(): void {
    if (this.expiryTimer !== null) this.timers.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private notify(): void {
    this.cleanup();
    const now = this.now();
    const deadlines = [...this.active.values()].flatMap((agent) =>
      agent.waitingSince !== null && this.waitingTimeoutMs > 0 && agent.waitingSince + this.waitingTimeoutMs > now
        ? [agent.waitingSince + this.waitingTimeoutMs] : []);
    if (deadlines.length) {
      this.expiryTimer = this.timers.setTimeout(() => { this.expiryTimer = null; this.notify(); }, Math.min(...deadlines) - now);
      this.expiryTimer.unref?.();
    }
    this.onChange?.(this.activeCount);
  }
}
