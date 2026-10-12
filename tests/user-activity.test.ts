import assert from "node:assert/strict";
import { test } from "node:test";
import { UserActivity, type ActivityWindows } from "../server/user-activity.ts";
import { AwakeManager, type TimerPort } from "../server/awake-manager.ts";
import { preferencesSchema } from "../shared/settings.ts";

class Clock implements TimerPort {
  time = 0;
  id = 0;
  pending = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) { const id = ++this.id; this.pending.set(id, { at: this.time + delay, callback }); return id; }
  clearTimeout(timer: unknown) { this.pending.delete(timer as number); }
  async advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const item = [...this.pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      this.time = item[1].at;
      this.pending.delete(item[0]);
      item[1].callback();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    this.time = end;
  }
}

function setup() {
  const clock = new Clock();
  const changes: ActivityWindows[] = [];
  const activity = new UserActivity({ timers: clock, onChange: (windows) => changes.push(windows) });
  return { clock, changes, activity };
}

test("user interactions slide the window; polls/windows reads do not", async () => {
  const { activity, clock } = setup();
  activity.note();
  await clock.advance(500_000);
  activity.note();
  assert.equal(activity.windows().interactionUntil, 1_100_000);
  for (let i = 0; i < 40; i++) { activity.windows(); await clock.advance(15_000); }
  assert.equal(activity.windows().interactionUntil, null);
  activity.cleanup();
});

test("changing activity duration keeps the original interaction time", async () => {
  const { activity, clock, changes } = setup();
  await clock.advance(100_000);
  activity.note();
  await clock.advance(60_000);
  activity.configure("auto", 5);
  assert.deepEqual(activity.windows(), { interactionUntil: 400_000 });
  await clock.advance(240_000);
  assert.deepEqual(changes.at(-1), { interactionUntil: null });
  activity.cleanup();
});

test("Disabled and Off do not create or replay activity; cleanup removes timers", async () => {
  const { activity, clock } = setup();
  activity.configure("auto", 0);
  activity.note();
  assert.equal(clock.pending.size, 0);
  activity.configure("off", 10);
  activity.note();
  activity.configure("auto", 10);
  assert.equal(activity.windows().interactionUntil, null);
  activity.note();
  activity.cleanup();
  assert.equal(clock.pending.size, 0);
  activity.note();
  assert.equal(clock.pending.size, 0);
});

test("disabled and expired activity cannot be replayed by increasing its duration", async () => {
  const { activity, clock } = setup();
  activity.note();
  activity.configure("auto", 0);
  activity.configure("auto", 10);
  assert.equal(activity.windows().interactionUntil, null);
  activity.configure("auto", 1);
  activity.note();
  await clock.advance(60_000);
  activity.configure("auto", 10);
  assert.equal(activity.windows().interactionUntil, null);
  assert.equal(clock.pending.size, 0);
  activity.configure("auto", 1);
  activity.note();
  clock.time += 60_000;
  activity.configure("auto", 10);
  assert.equal(activity.windows().interactionUntil, null);
  assert.equal(clock.pending.size, 0);
  activity.cleanup();
});

test("activity task releases exactly on deadline while an independent agent task continues", async () => {
  const clock = new Clock();
  const live = new Set<string>();
  const puts: string[] = [];
  const tasks = {
    inspectTask: async () => null,
    upsertTask: async (name: string) => { live.add(name); puts.push(name); },
    deleteTask: async (name: string) => { live.delete(name); },
  };
  const agent = new AwakeManager({ tasks, taskName: "agent", timers: clock, log: () => undefined });
  const user = new AwakeManager({ tasks, taskName: "activity", timers: clock, log: () => undefined });
  const activity = new UserActivity({ timers: clock, onChange: (windows) => user.setMode(windows.interactionUntil !== null ? "always" : "off") });
  activity.configure("auto", 1);
  user.setIntegration("available");
  agent.setMode("auto"); agent.setIntegration("available"); agent.finishInitialReconciliation(); agent.setActiveAgentCount(1);
  activity.note();
  await Promise.all([agent.waitForCurrentSync(), user.waitForCurrentSync()]);
  assert.deepEqual([...live].sort(), ["activity", "agent"]);
  await clock.advance(60_000);
  assert.deepEqual([...live], ["agent"]);
  await clock.advance(600_000);
  assert.ok(puts.filter((name) => name === "agent").length >= 11);
  assert.deepEqual([...live], ["agent"]);
  activity.cleanup(); await agent.shutdown(); await user.shutdown();
});

test("legacy settings gain finite defaults and invalid durations are rejected", () => {
  const value = preferencesSchema.parse({ mode: "auto" });
  assert.equal(value.interactionHoldMinutes, 10);
  assert.equal(value.waitingTimeoutMinutes, 10);
  assert.deepEqual(Object.keys(value).sort(), ["interactionHoldMinutes", "mode", "waitingTimeoutMinutes"]);
  assert.equal(preferencesSchema.safeParse({ interactionHoldMinutes: 61 }).success, false);
  assert.equal(preferencesSchema.safeParse({ interactionHoldMinutes: -1 }).success, false);
});
