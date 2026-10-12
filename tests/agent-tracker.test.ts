import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentTracker, type AgentDirectoryEntry, type AgentSnapshot } from "../server/agent-tracker.ts";

function agent(
  id: string,
  options: Partial<AgentSnapshot> = {},
): AgentSnapshot {
  return { id, archivedAt: null, activeTurn: null, pendingPermissions: [], ...options };
}

test("tracks multiple workspaces and child agents independently", () => {
  const tracker = new AgentTracker();
  tracker.turnStarted("parent-a", "turn-1");
  tracker.turnStarted("child-a", "child-turn");
  tracker.turnStarted("other-workspace-agent", null);

  tracker.applyEndRefresh("parent-a", "turn-1", agent("parent-a"), tracker.revisionFor("parent-a"));
  assert.equal(tracker.activeCount, 2);
  assert.deepEqual(tracker.activeAgentIds.sort(), ["child-a", "other-workspace-agent"]);
});

test("duplicate starts are idempotent for the active-agent count", () => {
  const tracker = new AgentTracker();
  tracker.turnStarted("agent-1", "turn-1");
  tracker.turnStarted("agent-1", "turn-1");
  assert.equal(tracker.activeCount, 1);
});

test("permission requests remain active until they are resolved", () => {
  const tracker = new AgentTracker();
  tracker.permissionRequested("agent-1", "permission-1");
  assert.equal(tracker.activeCount, 1);

  tracker.permissionResolved("agent-1", "permission-1");
  assert.equal(tracker.activeCount, 0);
});

test("authoritative permission and active-turn snapshots rebuild activity", () => {
  const tracker = new AgentTracker();
  tracker.applySnapshot(agent("permission-agent", {
    status: "permission",
    pendingPermissions: [{ id: "q-1" }],
  }));
  tracker.applySnapshot(agent("running-agent", {
    activeTurn: { turnId: "t-1", startedAt: "2026-10-11T10:00:00Z" },
  }));

  assert.equal(tracker.activeCount, 2);
});

test("an older end refresh cannot clear a newer turn", () => {
  const tracker = new AgentTracker();
  tracker.turnStarted("agent-1", "old-turn");
  const requestRevision = tracker.revisionFor("agent-1");
  tracker.turnStarted("agent-1", "new-turn");

  const applied = tracker.applyEndRefresh("agent-1", "old-turn", agent("agent-1"), requestRevision);
  assert.equal(applied, false);
  assert.equal(tracker.activeCount, 1);
  assert.deepEqual(tracker.activeAgentIds, ["agent-1"]);
});

test("nullable and reused turn IDs reconcile against the current snapshot", () => {
  const tracker = new AgentTracker();
  tracker.turnStarted("agent-1", null);
  const revision = tracker.revisionFor("agent-1");
  tracker.applyEndRefresh("agent-1", null, agent("agent-1", {
    activeTurn: { turnId: "same-id-after-reopen", startedAt: "2026-10-11T11:00:00Z" },
  }), revision);

  assert.equal(tracker.activeCount, 1);
  assert.deepEqual(tracker.activeAgentIds, ["agent-1"]);
});

test("a paged full snapshot includes background agents and clears stale idle entries", () => {
  const tracker = new AgentTracker();
  tracker.turnStarted("stale-agent", "stale-turn");
  const revisionAtScanStart = tracker.revision;
  const allPages: AgentDirectoryEntry[] = [
    { agent: agent("workspace-agent", { activeTurn: { turnId: "turn-a" } }) },
    { agent: agent("background-agent", { activeTurn: { turnId: "turn-b" } }) },
  ];
  tracker.applyFullSnapshot(allPages, revisionAtScanStart);

  assert.deepEqual(tracker.activeAgentIds.sort(), ["background-agent", "workspace-agent"]);
});

test("live events that arrive during a paged scan take precedence over its snapshot", () => {
  const tracker = new AgentTracker();
  const revisionAtScanStart = tracker.revision;
  tracker.turnStarted("new-agent", "new-turn");

  tracker.applyFullSnapshot([], revisionAtScanStart);
  assert.deepEqual(tracker.activeAgentIds, ["new-agent"]);
});

test("archived snapshots and archive events do not count as running", () => {
  const tracker = new AgentTracker();
  tracker.turnStarted("agent-1", "turn-1");
  tracker.applySnapshot(agent("agent-1", {
    archivedAt: "2026-10-11T11:00:00Z",
    activeTurn: { turnId: "turn-1" },
  }));
  assert.equal(tracker.activeCount, 0);
});

function timedTracker() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const counts: number[] = [];
  const tracker = new AgentTracker({
    now: () => now,
    onChange: (count) => counts.push(count),
    timers: {
      setTimeout: ((callback: () => void, delay: number) => {
        const id = ++nextId;
        pending.set(id, { at: now + delay, callback });
        return id;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((id: number) => pending.delete(id)) as unknown as typeof clearTimeout,
    },
  });
  return { tracker, counts, pending, advance(ms: number) {
    const end = now + ms;
    while (true) {
      const due = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      pending.delete(due[0]);
      due[1].callback();
    }
    now = end;
  } };
}

test("blocked turns expire autonomously and repeated snapshots do not renew the wait", () => {
  const { tracker, advance, counts } = timedTracker();
  const blocked = agent("a", { activeTurn: { turnId: "t" }, pendingPermissions: [{ id: "p" }] });
  tracker.applySnapshot(blocked);
  advance(300_000);
  tracker.applySnapshot(blocked);
  tracker.permissionRequested("a", "p");
  advance(300_000);
  assert.equal(tracker.activeCount, 0);
  assert.equal(counts.at(-1), 0);
  tracker.applySnapshot(blocked);
  assert.equal(tracker.activeCount, 0);
  tracker.permissionResolved("a", "p");
  assert.equal(tracker.activeCount, 1);
});

test("status-only waits expire while other working agents remain protected", () => {
  const { tracker, advance } = timedTracker();
  tracker.applySnapshot(agent("waiting", { status: "permission" }));
  tracker.turnStarted("working", null);
  advance(600_000);
  assert.deepEqual(tracker.activeAgentIds, ["working"]);
  tracker.permissionRequested("working", "p");
  tracker.permissionResolved("working", "p");
  assert.equal(tracker.activeCount, 1);
});

test("timeout changes apply to existing waits and Never disables expiration", () => {
  const { tracker, advance, pending } = timedTracker();
  tracker.permissionRequested("a", "p");
  advance(120_000);
  tracker.setWaitingTimeoutMinutes(1);
  assert.equal(tracker.activeCount, 0);
  tracker.setWaitingTimeoutMinutes(5);
  assert.equal(tracker.activeCount, 1);
  tracker.setWaitingTimeoutMinutes(0);
  advance(3_600_000);
  assert.equal(tracker.activeCount, 1);
  tracker.setWaitingTimeoutMinutes(10);
  assert.equal(tracker.activeCount, 0);
  tracker.turnStarted("a", "new");
  tracker.permissionRequested("a", "new-p");
  assert.equal(tracker.activeCount, 1);
  tracker.cleanup();
  assert.equal(pending.size, 0);
});

test("duplicate starts preserve blocked-turn deadlines; a new turn clears the wait", () => {
  const { tracker, advance } = timedTracker();
  tracker.turnStarted("a", "t");
  tracker.permissionRequested("a", "p");
  advance(300_000);
  tracker.turnStarted("a", "t");
  advance(300_000);
  assert.equal(tracker.activeCount, 0);
  tracker.turnStarted("a", "new");
  assert.equal(tracker.activeCount, 1);
  tracker.cleanup();
});
