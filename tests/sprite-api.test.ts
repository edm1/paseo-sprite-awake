import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { test } from "node:test";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  createNodeHttpRequest,
  SPRITE_HTTP_HOST,
  SPRITE_SOCKET_PATH,
  SpriteApiError,
  SpriteTasksApi,
  TASK_EXPIRY,
  taskPath,
} from "../server/sprite-api.ts";

test("uses the local Sprite socket and upserts only the named task", async () => {
  const calls: Array<{ method: string; path: string; body?: string; headers: Record<string, string>; host: string; socketPath: string }> = [];
  const api = new SpriteTasksApi({
    request: async (input) => {
      calls.push(input);
      return { statusCode: 204, headers: {}, body: "" };
    },
    statSocket: async () => ({ isSocket: () => true }),
  });

  await api.upsertTask("paseo-sprite-awake-test");
  await api.deleteTask("paseo-sprite-awake-test");

  assert.equal(calls[0]?.method, "PUT");
  assert.equal(calls[0]?.path, "/v1/tasks/paseo-sprite-awake-test");
  assert.equal(calls[0]?.body, JSON.stringify({ expire: "5m" }));
  assert.equal(calls[0]?.headers["Content-Type"], "application/json");
  assert.equal(calls[0]?.host, SPRITE_HTTP_HOST);
  assert.equal(calls[0]?.socketPath, SPRITE_SOCKET_PATH);
  assert.equal(calls[1]?.method, "DELETE");
  assert.equal(calls[1]?.path, calls[0]?.path);
  assert.equal(DEFAULT_HEARTBEAT_MS, 60_000);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 5_000);
  assert.equal(TASK_EXPIRY, "5m");
});

test("a 404 from the owned-task endpoint confirms the API is reachable", async () => {
  const api = new SpriteTasksApi({
    request: async () => ({ statusCode: 404, headers: {}, body: "not found" }),
    statSocket: async () => ({ isSocket: () => true }),
  });

  assert.deepEqual(await api.detect("paseo-sprite-awake-test"), { state: "available", task: null });
  await assert.doesNotReject(api.deleteTask("paseo-sprite-awake-test"));
});

test("reports a missing socket as unsupported and an inaccessible socket as an error", async () => {
  const missing = new SpriteTasksApi({
    statSocket: async () => {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    },
  });
  const inaccessible = new SpriteTasksApi({
    statSocket: async () => ({ isSocket: () => true }),
    request: async () => { throw new Error("EACCES"); },
  });

  assert.equal((await missing.detect("paseo-sprite-awake-test")).state, "unavailable");
  const error = await inaccessible.detect("paseo-sprite-awake-test");
  assert.equal(error.state, "error");
  if (error.state === "error") assert.match(error.diagnostic, /EACCES/);
});

test("rejects non-success HTTP statuses and invalid task names", async () => {
  const api = new SpriteTasksApi({
    request: async () => ({ statusCode: 503, headers: {}, body: "temporarily unavailable" }),
    statSocket: async () => ({ isSocket: () => true }),
  });

  await assert.rejects(api.upsertTask("paseo-sprite-awake-test"), (error: unknown) => {
    assert.ok(error instanceof SpriteApiError);
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /HTTP 503/);
    return true;
  });
  assert.throws(() => taskPath("other/app/task"), /Invalid Sprite task name/);
});

test("Node HTTP transport enforces an absolute request deadline", async () => {
  let destroyed = false;
  let inactivityTimeoutConfigured = false;
  const fakeRequest = Object.assign(new EventEmitter(), {
    setTimeout() { inactivityTimeoutConfigured = true; return this; },
    write(_body: string) { return true; },
    end() { return this; },
    destroy(_error?: Error) { destroyed = true; return this; },
  }) as unknown as ClientRequest;
  const send = createNodeHttpRequest((() => fakeRequest) as never);
  const pending = send({
    socketPath: SPRITE_SOCKET_PATH,
    host: SPRITE_HTTP_HOST,
    path: "/v1/tasks/paseo-sprite-awake-test",
    method: "GET",
    headers: { Host: SPRITE_HTTP_HOST },
    timeoutMs: 37,
  });
  await assert.rejects(pending, /timed out after 37 ms/);
  assert.equal(destroyed, true);
  assert.equal(inactivityTimeoutConfigured, false);
});
