import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentRuntime, type PaseoAgentPort } from "../server/agent-runtime.ts";
import { AgentTracker, type AgentDirectoryEntry, type AgentSnapshot } from "../server/agent-tracker.ts";

type DirectoryHandlers = {
  snapshot(snapshot: { entries: AgentDirectoryEntry[] }): void;
  update(message: unknown): void;
  error?(error: unknown): void;
};

class FakePaseo {
  calls: Array<{ filter: unknown; page: { limit: number; cursor?: string } }> = [];
  handlers: DirectoryHandlers | null = null;
  released = false;
  pages = new Map<string, { entries: AgentDirectoryEntry[]; nextCursor?: string }>();
  currentSnapshots = new Map<string, AgentSnapshot | null>();

  agents = {
    list: async (options: {
      filter: unknown;
      page: { limit: number; cursor?: string };
      subscribe?: Record<string, never>;
    }) => {
      this.calls.push({ filter: options.filter, page: options.page });
      const cursor = options.page.cursor ?? "first";
      const result = this.pages.get(cursor) ?? { entries: [] };
      return {
        entries: result.entries,
        pageInfo: { nextCursor: result.nextCursor ?? null },
        ...(options.subscribe ? {
          subscription: {
            subscribe: (handlers: DirectoryHandlers) => { this.handlers = handlers; },
            release: async () => { this.released = true; },
          },
        } : {}),
      };
    },
    ref: (agentId: string) => ({
      refresh: async (): Promise<void> => undefined,
      current: () => this.currentSnapshots.get(agentId) ?? null,
    }),
  };
}

function active(id: string, turnId = `${id}-turn`): AgentDirectoryEntry {
  return { agent: { id, activeTurn: { turnId } } };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeRuntime() {
  const tracker = new AgentTracker();
  const runtime = new AgentRuntime({ tracker, getManager: () => null, log: () => undefined });
  return { tracker, runtime };
}

test("startup reconciliation includes background agents and every page", async () => {
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [active("parent")], nextCursor: "second" });
  paseo.pages.set("second", {
    entries: [{ agent: { id: "child", parentAgentId: "parent", pendingPermissions: [{ id: "allow" }] } }],
  });
  const { tracker, runtime } = makeRuntime();

  runtime.initialize(paseo as unknown as PaseoAgentPort);
  await settle();

  assert.equal(tracker.activeCount, 2);
  assert.deepEqual(paseo.calls.map((call) => call.page.cursor ?? null), [null, "second"]);
  assert.deepEqual(paseo.calls[0]?.filter, { includeArchived: false, includeBackground: true });
  assert.ok(paseo.handlers);

  paseo.handlers?.update({
    type: "agent_update",
    payload: { kind: "upsert", agent: { id: "new-background", activeTurn: { turnId: "bg-turn" } } },
  });
  assert.equal(tracker.activeCount, 3);

  await runtime.cleanup();
  assert.equal(paseo.released, true);
});

test("a lifecycle start that arrives during the initial scan wins over its older snapshot", async () => {
  const paseo = new FakePaseo();
  let finishFirstPage!: (page: { entries: AgentDirectoryEntry[]; pageInfo: { nextCursor: null } }) => void;
  paseo.agents.list = async (options) => {
    paseo.calls.push({ filter: options.filter, page: options.page });
    await new Promise<void>((resolve) => { finishFirstPage = () => resolve(); });
    return {
      entries: [],
      pageInfo: { nextCursor: null },
      subscription: {
        subscribe: (handlers: DirectoryHandlers) => { paseo.handlers = handlers; },
        release: async () => { paseo.released = true; },
      },
    };
  };
  const { tracker, runtime } = makeRuntime();

  runtime.initialize(paseo as unknown as PaseoAgentPort);
  await Promise.resolve();
  runtime.turnStarted("live-agent", "new-turn", paseo as unknown as PaseoAgentPort);
  finishFirstPage({ entries: [], pageInfo: { nextCursor: null } });
  await settle();

  assert.deepEqual(tracker.activeAgentIds, ["live-agent"]);
  await runtime.cleanup();
});

test("a late directory snapshot cannot overwrite a newer lifecycle start", async () => {
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [] });
  const { tracker, runtime } = makeRuntime();

  runtime.initialize(paseo as unknown as PaseoAgentPort);
  await settle();
  runtime.turnStarted("agent", "live-turn", paseo as unknown as PaseoAgentPort);
  paseo.handlers?.snapshot({ entries: [{ agent: { id: "agent", activeTurn: null, status: "idle" } }] });

  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
  await runtime.cleanup();
});

test("a delayed stale directory update cannot clear a newer lifecycle start", async () => {
  const paseo = new FakePaseo();
  let finishReconcile: ((page: { entries: AgentDirectoryEntry[]; pageInfo: { nextCursor: null } }) => void) | undefined;
  paseo.currentSnapshots.set("agent", { id: "agent", activeTurn: { turnId: "live-turn" } });
  paseo.agents.list = async (options) => {
    paseo.calls.push({ filter: options.filter, page: options.page });
    if (options.subscribe) {
      return {
        entries: [{ agent: { id: "agent", activeTurn: null, status: "idle" } }],
        pageInfo: { nextCursor: null },
        subscription: {
          subscribe: (handlers: DirectoryHandlers) => { paseo.handlers = handlers; },
          release: async () => { paseo.released = true; },
        },
      };
    }
    return await new Promise((resolve) => {
      finishReconcile = (page) => resolve(page);
    });
  };
  const observedCounts: number[] = [];
  const tracker = new AgentTracker({ onChange: (count) => observedCounts.push(count) });
  const runtime = new AgentRuntime({ tracker, getManager: () => null, log: () => undefined });

  runtime.initialize(paseo as unknown as PaseoAgentPort);
  try {
    await settle();
    runtime.turnStarted("agent", "live-turn", paseo as unknown as PaseoAgentPort);
    await Promise.resolve();
    const countsBeforeDelayedUpdate = observedCounts.length;

    paseo.handlers?.update({
      type: "agent_update",
      payload: { kind: "upsert", agent: { id: "agent", activeTurn: null, status: "idle" } },
    });

    assert.deepEqual(tracker.activeAgentIds, ["agent"]);
    assert.ok(!observedCounts.slice(countsBeforeDelayedUpdate).includes(0));
  } finally {
    finishReconcile?.({ entries: [active("agent", "live-turn")], pageInfo: { nextCursor: null } });
    await runtime.cleanup();
  }
  await settle();
  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
});

test("a delayed old end refresh cannot clear a newer turn event", async () => {
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [] });
  let finishRefresh!: () => void;
  paseo.agents.ref = (agentId: string) => ({
    refresh: async () => new Promise<void>((resolve) => { finishRefresh = resolve; }),
    current: () => paseo.currentSnapshots.get(agentId) ?? null,
  });
  paseo.currentSnapshots.set("agent", { id: "agent", activeTurn: { turnId: "new-turn" } });
  const { tracker, runtime } = makeRuntime();

  tracker.turnStarted("agent", "old-turn");
  runtime.turnEnded("agent", "old-turn", paseo as unknown as PaseoAgentPort);
  await Promise.resolve();
  tracker.turnStarted("agent", "new-turn");
  finishRefresh();
  await settle();

  assert.equal(tracker.activeCount, 1);
  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
  await runtime.cleanup();
});

test("plugin cleanup does not wait indefinitely for a stalled directory release", async () => {
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [] });
  paseo.agents.list = async (options) => {
    paseo.calls.push({ filter: options.filter, page: options.page });
    return {
      entries: [],
      pageInfo: { nextCursor: null },
      subscription: {
        subscribe: (handlers: DirectoryHandlers) => { paseo.handlers = handlers; },
        release: async () => new Promise<void>(() => {}),
      },
    };
  };
  const logs: string[] = [];
  const tracker = new AgentTracker();
  const runtime = new AgentRuntime({
    tracker,
    getManager: () => null,
    cleanupTimeoutMs: 5,
    log: (_level, message) => logs.push(message),
  });

  runtime.initialize(paseo as unknown as PaseoAgentPort);
  await settle();
  await runtime.cleanup();

  assert.ok(logs.some((message) => message.includes("cleanup timed out")));
});

test("delayed idle and remove updates after reconciliation cannot clear a newer active turn", async () => {
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [] });
  const { tracker, runtime } = makeRuntime();
  runtime.initialize(paseo);
  await settle();
  paseo.pages.set("first", { entries: [active("a", "new")] });
  paseo.currentSnapshots.set("a", active("a", "new").agent);
  runtime.turnStarted("a", "new", paseo);
  await settle();
  for (const payload of [
    { kind: "upsert", agent: { id: "a", activeTurn: null, status: "idle" } },
    { kind: "upsert", agent: { id: "a", activeTurn: { turnId: "old" } } },
    { kind: "remove", agentId: "a" },
  ]) {
    paseo.handlers?.update({ type: "agent_update", payload });
    await settle();
    assert.equal(tracker.activeCount, 1);
  }
  await runtime.cleanup();
  tracker.cleanup();
});

test("a newer end event queues a refresh behind an in-flight stale refresh", async () => {
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [] });
  const { tracker, runtime } = makeRuntime();
  runtime.initialize(paseo);
  await settle();
  let resolveFirst!: () => void;
  let calls = 0;
  paseo.agents.ref = () => ({
    refresh: async (): Promise<void> => {
      calls++;
      if (calls === 1) await new Promise<void>((resolve) => { resolveFirst = resolve; });
    },
    current: () => ({ id: "a", activeTurn: null }),
  });
  tracker.turnStarted("a", "old");
  runtime.turnEnded("a", "old", paseo);
  tracker.turnStarted("a", "new");
  runtime.turnEnded("a", "new", paseo);
  resolveFirst();
  await settle();
  assert.equal(calls, 2);
  assert.equal(tracker.activeCount, 0);
  await runtime.cleanup();
});

test("a stalled directory request retries and releases its late subscription without applying stale state", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [active("agent", "live")] });
  const list = paseo.agents.list;
  let attempts = 0;
  let finishFirst!: (page: Awaited<ReturnType<typeof list>>) => void;
  paseo.agents.list = async (options) => {
    attempts++;
    if (attempts === 1) return await new Promise((resolve) => { finishFirst = resolve; });
    return await list(options);
  };
  const { tracker, runtime } = makeRuntime();
  context.after(() => runtime.cleanup());
  runtime.initialize(paseo);
  context.mock.timers.tick(5_000);
  await settle();
  assert.equal(runtime.initialReconciliationComplete, false);
  context.mock.timers.tick(60_000);
  await settle();
  assert.equal(attempts, 2);
  assert.equal(runtime.initialReconciliationComplete, true);
  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
  let lateReleased = false;
  finishFirst({ entries: [], pageInfo: { nextCursor: null }, subscription: {
    subscribe: () => assert.fail("Timed-out observation must not be installed"),
    release: async () => { lateReleased = true; },
  } });
  await settle();
  assert.equal(lateReleased, true);
  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
});

test("a stalled later directory page retries without discarding work", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const paseo = new FakePaseo();
  paseo.pages.set("first", { entries: [active("agent")], nextCursor: "second" });
  const list = paseo.agents.list;
  let stalled = false;
  paseo.agents.list = async (options) => {
    if (options.page.cursor === "second" && !stalled) {
      stalled = true;
      return await new Promise(() => {});
    }
    return await list(options);
  };
  const { tracker, runtime } = makeRuntime();
  context.after(() => runtime.cleanup());
  tracker.turnStarted("agent", "agent-turn");
  runtime.initialize(paseo);
  await settle();
  context.mock.timers.tick(5_000);
  await settle();
  assert.equal(runtime.initialReconciliationComplete, false);
  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
  context.mock.timers.tick(60_000);
  await settle();
  assert.equal(runtime.initialReconciliationComplete, true);
  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
});

test("a stalled refresh cannot block a queued end or apply its late snapshot", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const paseo = new FakePaseo();
  const { tracker, runtime } = makeRuntime();
  context.after(() => runtime.cleanup());
  runtime.initialize(paseo);
  await settle();
  let finishFirst!: () => void;
  let attempts = 0;
  paseo.agents.ref = () => ({
    refresh: async () => {
      attempts++;
      if (attempts === 1) await new Promise<void>((resolve) => { finishFirst = resolve; });
    },
    current: () => ({ id: "agent", activeTurn: null }),
  });
  tracker.turnStarted("agent", "old");
  runtime.turnEnded("agent", "old", paseo);
  tracker.turnStarted("agent", "new");
  runtime.turnEnded("agent", "new", paseo);
  context.mock.timers.tick(5_000);
  await settle();
  assert.equal(attempts, 2);
  assert.equal(tracker.activeCount, 0);
  tracker.turnStarted("agent", "third");
  finishFirst();
  await settle();
  assert.deepEqual(tracker.activeAgentIds, ["agent"]);
});
