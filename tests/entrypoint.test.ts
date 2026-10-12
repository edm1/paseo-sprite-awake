import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { test, type TestContext } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";
import { SpriteTasksApi, type SpriteDetection } from "../server/sprite-api.ts";
import { preferencesSchema, readStatus, noteUserActivity } from "../shared/settings.ts";

type Preferences = ReturnType<typeof preferencesSchema.parse>;
type SettingsState = { status: "ready"; revision: string; values: Preferences };
const ready = (patch: Partial<Preferences>, revision = "1"): SettingsState => ({ status: "ready", revision, values: preferencesSchema.parse(patch) });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise<void>((resolve) => setImmediate(resolve)); };

function setup(t: TestContext, initial: Promise<SettingsState> = Promise.resolve(ready({})), detection: SpriteDetection | null = null) {
  const originals = { detect: SpriteTasksApi.prototype.detect, upsert: SpriteTasksApi.prototype.upsertTask, delete: SpriteTasksApi.prototype.deleteTask };
  const live = new Set<string>();
  const puts: string[] = [];
  SpriteTasksApi.prototype.detect = async (name) => detection ?? { state: "available", task: live.has(name) ? { name } : null };
  SpriteTasksApi.prototype.upsertTask = async (name) => { live.add(name); puts.push(name); };
  SpriteTasksApi.prototype.deleteTask = async (name) => { live.delete(name); };
  type Handler = (input: unknown, context: { paseo: unknown }) => unknown;
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  let subscriber: (state: SettingsState) => void = () => undefined;
  let releases = 0;
  let lists = 0;
  const sdk = { agents: {
    list: async () => { lists++; return { entries: [], subscription: { subscribe: () => undefined, release: async () => { releases++; } } }; },
    ref: () => ({ refresh: async () => undefined, current: () => null }),
  } };
  const server = {
    registerSettings: () => ({ read: () => initial, subscribe: (listener: typeof subscriber) => { subscriber = listener; return () => { subscriber = () => undefined; }; } }),
    handle: (contract: { name: string }, handler: Handler) => { handlers.set(contract.name, handler); },
    on: (name: string, handler: Handler) => { hooks.set(name, handler); return () => { hooks.delete(name); }; },
    before: (name: string, handler: Handler) => { hooks.set(name, handler); return () => { hooks.delete(name); }; },
  };
  const cleanup = contribute(server as unknown as PluginServerContext);
  t.after(async () => {
    await cleanup();
    SpriteTasksApi.prototype.detect = originals.detect;
    SpriteTasksApi.prototype.upsertTask = originals.upsert;
    SpriteTasksApi.prototype.deleteTask = originals.delete;
  });
  return { live, puts, sdk, handlers, hooks, update: (state: SettingsState) => subscriber(state),
    stats: () => ({ lists, releases }), cleanup,
    rpc: async (name: string, input: unknown = {}) => await handlers.get(name)?.(input, { paseo: sdk }) as Record<string, unknown>,
  };
}

test("owned task identity uses PASEO_HOME and the plugin ID", async (t) => {
  const previousHome = process.env.PASEO_HOME;
  const paseoHome = "/configured/paseo-home";
  process.env.PASEO_HOME = paseoHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });

  const f = setup(t);
  await settle();
  f.hooks.get("agent.turn_started")?.({ agent: { id: "a" }, turnId: "t" }, { paseo: f.sdk });
  await settle();

  const identity = `${paseoHome}\npaseo-sprite-awake`;
  const expectedName = `paseo-sprite-awake-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  assert.deepEqual(f.puts, [expectedName]);
});

test("owned task identity falls back to the home directory", async (t) => {
  const previousHome = process.env.PASEO_HOME;
  delete process.env.PASEO_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
  });

  const f = setup(t);
  await settle();
  f.hooks.get("agent.turn_started")?.({ agent: { id: "a" }, turnId: "t" }, { paseo: f.sdk });
  await settle();

  const identity = `${homedir()}\npaseo-sprite-awake`;
  const expectedName = `paseo-sprite-awake-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
  assert.deepEqual(f.puts, [expectedName]);
});

test("entrypoint status polling creates no activity task and avoids repeat scans", async (t) => {
  const f = setup(t);
  await settle();
  for (let i = 0; i < 20; i++) await f.rpc(readStatus.name);
  await settle();
  assert.equal(f.stats().lists, 1);
  assert.equal(f.puts.length, 0);
  assert.equal(f.live.size, 0);
});

test("explicit activity on an unsupported host remains unavailable", async (t) => {
  const fixture = setup(t, Promise.resolve(ready({})), { state: "unavailable", diagnostic: "No Sprite socket" });
  await settle();
  assert.equal((await fixture.rpc(noteUserActivity.name, { source: "manual" })).protected, false);
  const status = await fixture.rpc(readStatus.name);
  assert.equal(status.state, "unavailable");
  assert.equal(status.taskConfirmed, false);
  assert.equal(fixture.puts.length, 0);
});

test("explicit interaction creates a separate activity task; Off clears it and does not replay activity", async (t) => {
  const f = setup(t);
  await settle();
  const result = await f.rpc(noteUserActivity.name, { source: "manual" });
  assert.equal(result.protected, true);
  assert.ok([...f.live].every((name) => name.endsWith("-activity")));
  const status = await f.rpc(readStatus.name);
  assert.equal(status.state, "interactive");
  assert.equal(status.activeAgents, 0);
  assert.equal(status.activityTaskConfirmed, true);
  f.update(ready({ mode: "off" }, "2"));
  await settle();
  assert.equal(f.live.size, 0);
  assert.equal((await f.rpc(noteUserActivity.name, { source: "manual" })).protected, false);
  f.update(ready({ mode: "auto" }, "3"));
  await settle();
  assert.equal(f.live.size, 0);
});

test("workspace setup hooks hold before agent activity and shutdown releases both owned tasks", async (t) => {
  const f = setup(t);
  await settle();
  const request = { projectId: "p", name: "new" };
  assert.equal(f.hooks.get("workspace.create")?.({ request }, { paseo: f.sdk }), undefined);
  await settle();
  assert.equal(f.live.size, 1);
  f.hooks.get("agent.turn_started")?.({ agent: { id: "a" }, turnId: "t" }, { paseo: f.sdk });
  await settle();
  assert.equal(f.live.size, 2);
  await f.cleanup();
  assert.equal(f.live.size, 0);
  assert.equal(f.hooks.size, 0);
});

test("new subscribed settings win over a delayed initial read", async (t) => {
  let resolve!: (state: SettingsState) => void;
  const initial = new Promise<SettingsState>((done) => { resolve = done; });
  const f = setup(t, initial);
  f.update(ready({ mode: "off" }, "new"));
  resolve(ready({ mode: "always" }, "old"));
  await settle();
  assert.equal((await f.rpc(readStatus.name)).mode, "off");
  assert.equal(f.live.size, 0);
});

test("Disabled activity duration declines explicit holds without affecting agent work", async (t) => {
  const f = setup(t, Promise.resolve(ready({ interactionHoldMinutes: 0 })));
  await settle();
  assert.equal((await f.rpc(noteUserActivity.name, { source: "manual" })).protected, false);
  f.hooks.get("agent.turn_started")?.({ agent: { id: "a" }, turnId: "t" }, { paseo: f.sdk });
  await settle();
  assert.equal(f.live.size, 1);
  assert.ok(![...f.live][0]?.endsWith("-activity"));
});
