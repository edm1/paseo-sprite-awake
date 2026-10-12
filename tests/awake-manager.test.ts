import assert from "node:assert/strict";
import { test } from "node:test";
import { AwakeManager, DEFAULT_GRACE_MS, type TimerPort } from "../server/awake-manager.ts";
import type { SpriteTaskPort } from "../server/sprite-api.ts";

class ManualTimers implements TimerPort {
  private current = 0;
  private sequence = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.current; }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.tasks.delete(timer as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.current = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.current = target;
  }
}

class FakeTasks implements SpriteTaskPort {
  calls: Array<{ action: "inspect" | "put" | "delete"; name: string }> = [];
  exists = false;
  failNextPut = 0;
  failNextDelete = 0;

  async inspectTask(name: string): Promise<unknown | null> {
    this.calls.push({ action: "inspect", name });
    return this.exists ? { name } : null;
  }

  async upsertTask(name: string): Promise<void> {
    this.calls.push({ action: "put", name });
    if (this.failNextPut > 0) {
      this.failNextPut -= 1;
      throw new Error("injected PUT failure");
    }
    this.exists = true;
  }

  async deleteTask(name: string): Promise<void> {
    this.calls.push({ action: "delete", name });
    if (this.failNextDelete > 0) {
      this.failNextDelete -= 1;
      throw new Error("injected DELETE failure");
    }
    this.exists = false;
  }
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeManager(options: {
  tasks?: FakeTasks;
  timers?: ManualTimers;
  graceMs?: number;
} = {}) {
  const tasks = options.tasks ?? new FakeTasks();
  const timers = options.timers ?? new ManualTimers();
  const manager = new AwakeManager({
    tasks,
    taskName: "paseo-sprite-awake-test",
    timers,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    heartbeatMs: 60_000,
    retryBaseMs: 5_000,
    retryMaxMs: 60_000,
    log: () => undefined,
  });
  return { manager, tasks, timers };
}

async function startup(manager: AwakeManager, taskExists = false): Promise<void> {
  manager.setMode("auto");
  manager.setIntegration("available", null, taskExists);
  manager.finishInitialReconciliation();
  await flush();
}

test("pending integration detection cannot report idle after agent reconciliation", async () => {
  const { manager, tasks } = makeManager();
  manager.setMode("auto");
  manager.finishInitialReconciliation();
  await flush();
  assert.equal(manager.getStatus().state, "checking");
  assert.equal(manager.getStatus().taskConfirmed, false);
  assert.equal(tasks.calls.length, 0);
});

test("one active agent acquires a shared keep-awake task", async () => {
  const { manager, tasks } = makeManager();
  await startup(manager);

  manager.setActiveAgentCount(1);
  await flush();

  assert.deepEqual(tasks.calls.filter((call) => call.action === "put"), [
    { action: "put", name: "paseo-sprite-awake-test" },
  ]);
  assert.equal(manager.getStatus().state, "working");
  assert.equal(manager.getStatus().taskConfirmed, true);
});

test("disconnecting clients does not affect an active task hold", async () => {
  const { manager, tasks } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();

  // There is intentionally no client-count input to the state machine.
  await flush();
  assert.equal(manager.getStatus().state, "working");
  assert.equal(tasks.exists, true);
});

test("last agent finish starts a grace period and then releases the task", async () => {
  const { manager, tasks, timers } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();
  manager.setActiveAgentCount(0);
  await flush();

  assert.equal(manager.getStatus().state, "grace");
  await timers.advance(DEFAULT_GRACE_MS - 1);
  assert.equal(tasks.exists, true);
  await timers.advance(1);
  assert.equal(tasks.exists, false);
  assert.equal(manager.getStatus().state, "idle");
});

test("a new turn during grace cancels release", async () => {
  const { manager, tasks, timers } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();
  manager.setActiveAgentCount(0);
  await timers.advance(30_000);
  manager.setActiveAgentCount(1);
  await flush();
  await timers.advance(DEFAULT_GRACE_MS);

  assert.equal(tasks.exists, true);
  assert.equal(tasks.calls.filter((call) => call.action === "delete").length, 0);
  assert.equal(manager.getStatus().state, "working");
});

test("two agents share one task; finishing the first does not release it", async () => {
  const { manager, tasks } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();
  manager.setActiveAgentCount(2);
  manager.setActiveAgentCount(1);
  await flush();

  assert.equal(tasks.calls.filter((call) => call.action === "put").length, 1);
  assert.equal(tasks.calls.filter((call) => call.action === "delete").length, 0);
  assert.equal(manager.getStatus().activeAgents, 1);
});

test("failed and cancelled turns finish through the same authoritative count", async () => {
  const { manager, tasks } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();
  // Paseo reports completed, failed, and cancelled outcomes through the same
  // turn_ended hook. The tracker supplies the reconciled count here.
  for (const _outcome of ["completed", "failed", "cancelled"]) {
    manager.setActiveAgentCount(0);
    assert.equal(manager.getStatus().state, "grace");
    manager.setActiveAgentCount(1);
  }
  await flush();
  assert.equal(tasks.exists, true);
});

test("a child agent keeps the Sprite awake after its parent finishes", async () => {
  const { manager, tasks } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(2);
  await flush();
  manager.setActiveAgentCount(1);
  await flush();

  assert.equal(manager.getStatus().state, "working");
  assert.equal(tasks.exists, true);
  assert.equal(tasks.calls.some((call) => call.action === "delete"), false);
});

test("heartbeat upserts again to recreate a task that expired or disappeared", async () => {
  const { manager, tasks, timers } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();
  tasks.exists = false;
  await timers.advance(60_000);

  assert.equal(tasks.exists, true);
  assert.equal(tasks.calls.filter((call) => call.action === "put").length, 2);
});

test("restart with confirmed work reacquires a task; idle restart deletes stale owned task", async () => {
  const active = makeManager();
  active.manager.setMode("auto");
  active.manager.setIntegration("available", null, false);
  active.manager.setActiveAgentCount(2);
  active.manager.finishInitialReconciliation();
  await flush();
  assert.equal(active.tasks.calls.filter((call) => call.action === "put").length, 1);

  const idleTasks = new FakeTasks();
  idleTasks.exists = true;
  const idle = makeManager({ tasks: idleTasks });
  await startup(idle.manager, true);
  assert.equal(idleTasks.calls.filter((call) => call.action === "delete").length, 1);
});

test("Sprite API failure is reported and retried with bounded backoff", async () => {
  const tasks = new FakeTasks();
  tasks.failNextPut = 1;
  const { manager, timers } = makeManager({ tasks });
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();

  assert.equal(manager.getStatus().state, "error");
  assert.match(manager.getStatus().error ?? "", /renewal failed/);
  await timers.advance(5_000);
  assert.equal(tasks.calls.filter((call) => call.action === "put").length, 2);
  assert.equal(manager.getStatus().state, "working");
});

test("Auto, Off and Always mode changes acquire and release the same task", async () => {
  const { manager, tasks } = makeManager();
  await startup(manager);
  manager.setMode("always");
  await flush();
  assert.equal(manager.getStatus().state, "always");

  manager.setMode("off");
  await flush();
  assert.equal(manager.getStatus().state, "off");
  assert.equal(tasks.exists, false);

  manager.setActiveAgentCount(1);
  manager.setMode("auto");
  await flush();
  assert.equal(manager.getStatus().state, "working");
  assert.equal(tasks.exists, true);
});

test("an unsupported host remains unavailable and never claims protection", async () => {
  const { manager, tasks } = makeManager();
  manager.setMode("auto");
  manager.setIntegration("unavailable", "socket absent");
  manager.setActiveAgentCount(1);
  assert.equal(manager.getStatus().state, "unavailable");
  assert.equal(manager.getStatus().taskConfirmed, false);
  assert.equal(tasks.calls.length, 0);
});

test("shutdown stops timers and attempts to release an owned hold", async () => {
  const { manager, tasks } = makeManager();
  await startup(manager);
  manager.setMode("always");
  await flush();
  await manager.shutdown();

  assert.equal(tasks.calls.at(-1)?.action, "delete");
  assert.equal(tasks.exists, false);
});

test("shutdown makes a best-effort delete when startup detection failed", async () => {
  const tasks = new FakeTasks();
  tasks.exists = true;
  const { manager } = makeManager({ tasks });
  manager.setMode("auto");
  manager.setIntegrationError("Sprite socket access failed");

  await manager.shutdown();

  assert.deepEqual(tasks.calls, [
    { action: "delete", name: "paseo-sprite-awake-test" },
  ]);
  assert.equal(tasks.exists, false);
});

test("waiting timeout releases after grace, survives reconciliation and protects other agents", async () => {
  const { manager, tasks, timers } = makeManager();
  const { AgentTracker } = await import("../server/agent-tracker.ts");
  const tracker = new AgentTracker({
    now: () => timers.now(),
    timers: {
      setTimeout: ((callback: () => void, delay: number) => timers.setTimeout(callback, delay)) as unknown as typeof setTimeout,
      clearTimeout: ((timer: unknown) => timers.clearTimeout(timer)) as typeof clearTimeout,
    },
    onChange: (count) => manager.setActiveAgentCount(count),
  });
  tracker.setWaitingTimeoutMinutes(1);
  await startup(manager);
  tracker.turnStarted("a", "t");
  tracker.permissionRequested("a", "p");
  await flush();
  await timers.advance(60_000);
  assert.equal(manager.getStatus().state, "grace");
  assert.equal(tasks.exists, true);
  tracker.applySnapshot({ id: "a", activeTurn: { turnId: "t" }, pendingPermissions: [{ id: "p" }] });
  await timers.advance(60_000);
  assert.equal(tasks.exists, false);
  assert.equal(manager.getStatus().state, "idle");
  tracker.permissionResolved("a", "p");
  await flush();
  assert.equal(tasks.exists, true);
  tracker.turnStarted("b", "other");
  tracker.permissionRequested("a", "p2");
  await timers.advance(60_000);
  assert.equal(manager.getStatus().activeAgents, 1);
  assert.equal(tasks.exists, true);
  tracker.cleanup();
  await manager.shutdown();
});

test("frequent unchanged counts cannot postpone lease heartbeats", async () => {
  const { manager, tasks, timers } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();
  for (let i = 0; i < 24; i++) {
    await timers.advance(15_000);
    manager.setActiveAgentCount(1);
    await flush();
  }
  assert.equal(tasks.calls.filter((call) => call.action === "put").length, 7);
  await manager.shutdown();
});

test("repeated reconciliation does not cancel an existing grace period", async () => {
  const { manager, tasks, timers } = makeManager();
  await startup(manager);
  manager.setActiveAgentCount(1);
  await flush();
  manager.setActiveAgentCount(0);
  await timers.advance(10_000);
  manager.finishInitialReconciliation();
  await flush();
  assert.equal(tasks.exists, true);
  assert.equal(manager.getStatus().state, "grace");
  await timers.advance(50_000);
  assert.equal(tasks.exists, false);
});
