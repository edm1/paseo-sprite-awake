import assert from "node:assert/strict";
import { test } from "node:test";
import { observeClientActivity, type BrowserDocument, type BrowserEvent } from "../client/activity-observer.ts";

class Document implements BrowserDocument {
  visibilityState = "visible";
  callbacks = new Map<string, (event: BrowserEvent) => void>();
  addEventListener(type: string, callback: (event: BrowserEvent) => void) { this.callbacks.set(type, callback); }
  removeEventListener(type: string) { this.callbacks.delete(type); }
  fire(type: string, trusted = true) { this.callbacks.get(type)?.({ isTrusted: trusted }); }
}
function fixture() {
  const document = new Document();
  const signals: string[] = [];
  let now = 0; let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const cleanup = observeClientActivity({ document, now: () => now, send: (source) => signals.push(source), timers: {
    setTimeout: ((callback: () => void, delay: number) => { const key = ++id; timers.set(key, { at: now + delay, callback }); return key; }) as unknown as typeof setTimeout,
    clearTimeout: ((key: number) => timers.delete(key)) as unknown as typeof clearTimeout,
  } });
  return { document, signals, timers, cleanup, advance(ms: number) {
    now += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); }
  } };
}

test("browser listener works outside settings and sends nothing on mount or synthetic/hidden input", () => {
  const f = fixture();
  assert.deepEqual(f.signals, []);
  assert.deepEqual([...f.document.callbacks.keys()], ["pointerdown", "keydown", "wheel"]);
  f.document.fire("pointerdown", false);
  f.document.visibilityState = "hidden";
  f.document.fire("keydown");
  assert.deepEqual(f.signals, []);
  f.document.visibilityState = "visible";
  f.document.fire("wheel");
  assert.deepEqual(f.signals, ["web-input"]);
  f.advance(600_000);
  assert.equal(f.signals.length, 1);
  f.cleanup();
});

test("input bursts are coalesced without a repeating heartbeat; hidden/unloaded pending input is discarded", () => {
  const f = fixture();
  f.document.fire("pointerdown");
  for (let i = 0; i < 100; i++) f.document.fire("keydown");
  assert.equal(f.signals.length, 1);
  assert.equal(f.timers.size, 1);
  f.advance(5_000);
  assert.equal(f.signals.length, 2);
  f.advance(60_000);
  assert.equal(f.signals.length, 2);
  f.document.fire("wheel");
  f.document.fire("wheel");
  f.document.visibilityState = "hidden";
  f.advance(5_000);
  assert.equal(f.signals.length, 3);
  f.document.visibilityState = "visible";
  f.document.fire("keydown"); f.document.fire("keydown");
  const count = f.signals.length;
  f.cleanup();
  f.advance(5_000);
  assert.equal(f.signals.length, count);
  assert.equal(f.document.callbacks.size, 0);
  assert.equal(f.timers.size, 0);
});

test("native mount/reconnect and repeated active events do not signal; real foreground transitions do", () => {
  const signals: string[] = [];
  let callback: ((state: string) => void) | null = null;
  let removed = false;
  const cleanup = observeClientActivity({ send: (source) => signals.push(source), appState: {
    currentState: "active", onChange: (handler) => { callback = handler; return () => { removed = true; }; },
  } });
  const change = (state: string) => (callback as unknown as (state: string) => void)(state);
  assert.deepEqual(signals, []);
  change("active"); change("active");
  assert.deepEqual(signals, []);
  change("background"); change("active"); change("active");
  change("inactive"); change("active");
  assert.deepEqual(signals, ["app-foreground", "app-foreground"]);
  cleanup();
  assert.equal(removed, true);
  change("background"); change("active");
  assert.equal(signals.length, 2);
});
