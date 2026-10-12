import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AgentTracker } from "./server/agent-tracker.ts";
import { AgentRuntime } from "./server/agent-runtime.ts";
import { AwakeManager } from "./server/awake-manager.ts";
import { SpriteTasksApi, type SpriteDetection } from "./server/sprite-api.ts";
import { UserActivity } from "./server/user-activity.ts";
import { awakeSettings, readStatus, noteUserActivity, preferencesSchema, type AwakePreferences } from "./shared/settings.ts";

const PLUGIN_ID = "paseo-sprite-awake";

function ownedTaskName(): string {
  const identity = `${process.env.PASEO_HOME ?? homedir()}\n${PLUGIN_ID}`;
  return `paseo-sprite-awake-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export default function contribute(server: PluginServerContext) {
  const taskName = ownedTaskName();
  const activityTaskName = `${taskName}-activity`;
  const spriteApi = new SpriteTasksApi();
  const settings = server.registerSettings(awakeSettings);
  const manager = new AwakeManager({ tasks: spriteApi, taskName });
  // Separate task: expiry of user activity can never delete an agent's hold.
  const activityManager = new AwakeManager({ tasks: spriteApi, taskName: activityTaskName });
  let stopping = false;
  let preferences = preferencesSchema.parse({});
  let settingsArrivalSequence = 0;
  let latestAppliedSettingsSequence = 0;
  const tracker = new AgentTracker({ onChange: (count) => manager.setActiveAgentCount(count) });
  const agentRuntime = new AgentRuntime({ tracker, getManager: () => manager });
  const activity = new UserActivity({ onChange: (windows) => {
    if (!stopping) activityManager.setMode(windows.interactionUntil !== null ? "always" : "off");
  } });
  // Settings must be ready before any user-activity task can be acquired.
  activity.configure("off", 0);

  const watchIntegration = (target: AwakeManager, name: string) => {
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const apply = (result: SpriteDetection): void => {
      if (stopping) return;
      if (result.state === "available") {
        failures = 0;
        target.setIntegration("available", null, result.task !== null);
      } else if (result.state === "unavailable") {
        target.setIntegration("unavailable", result.diagnostic);
      } else {
        target.setIntegrationError(result.diagnostic);
        if (retry === null) {
          const delay = Math.min(5_000 * 2 ** Math.min(failures++, 4), 60_000);
          retry = setTimeout(() => { retry = null; if (!stopping) void detect(); }, delay);
          retry.unref?.();
        }
      }
    };
    const detect = async (): Promise<void> => {
      try { apply(await spriteApi.detect(name)); }
      catch (error) { apply({ state: "error", diagnostic: `Sprite Tasks API detection failed: ${errorMessage(error)}` }); }
    };
    return { ready: detect(), cleanup: () => { if (retry !== null) clearTimeout(retry); retry = null; } };
  };
  const agentIntegration = watchIntegration(manager, taskName);
  const activityIntegration = watchIntegration(activityManager, activityTaskName);

  const recordActivity = async () => {
    if (stopping) return { protected: false };
    await activityIntegration.ready;
    if (stopping) return { protected: false };
    activity.note();
    await activityManager.waitForCurrentSync();
    const status = activityManager.getStatus();
    return { protected: status.taskConfirmed && status.mode === "always" };
  };

  const applyPreferences = (next: AwakePreferences): void => {
    if (stopping) return;
    preferences = next;
    tracker.setWaitingTimeoutMinutes(next.waitingTimeoutMinutes);
    manager.setMode(next.mode);
    manager.setActiveAgentCount(tracker.activeCount);
    if (agentRuntime.initialReconciliationComplete) manager.finishInitialReconciliation();
    activity.configure(next.mode, next.interactionHoldMinutes);
  };
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>, sequence: number): void => {
    if (stopping || sequence < latestAppliedSettingsSequence || state.status !== "ready") return;
    latestAppliedSettingsSequence = sequence;
    applyPreferences(state.values);
  };

  // These hooks run for direct and relay users. Reads and connection events do not.
  const interaction = (paseo: unknown): void => {
    if (stopping) return;
    activity.note();
    agentRuntime.initialize(paseo);
  };
  const removers = [
    server.before("workspace.create", (_event, { paseo }) => { interaction(paseo); }),
    server.before("agent.create", (_event, { paseo }) => { interaction(paseo); }),
    server.on("workspace.created", (_event, { paseo }) => { interaction(paseo); }),
    server.on("workspace.archived", (_event, { paseo }) => { interaction(paseo); }),
    server.on("agent.created", (_event, { paseo }) => { interaction(paseo); }),
    server.on("agent.turn_started", (event, { paseo }) => { agentRuntime.turnStarted(event.agent.id, event.turnId, paseo); }),
    server.on("agent.turn_ended", (event, { paseo }) => { agentRuntime.turnEnded(event.agent.id, event.turnId, paseo); }),
    server.on("agent.permission_requested", (event, { paseo }) => { agentRuntime.permissionRequested(event.agent.id, event.request.id, paseo); }),
    server.on("agent.permission_resolved", (event, { paseo }) => {
      activity.note();
      agentRuntime.permissionResolved(event.agent.id, event.requestId, paseo);
    }),
    server.on("agent.closed", (event, { paseo }) => { interaction(paseo); agentRuntime.agentClosed(event.agent.id, paseo); }),
    server.on("agent.archived", (event, { paseo }) => { interaction(paseo); agentRuntime.agentArchived(event.agent.id); }),
  ];
  const initialReadSequence = ++settingsArrivalSequence;
  const unsubscribe = settings.subscribe((next) => applySettings(next, ++settingsArrivalSequence));
  void settings.read().then((state) => {
    if (state.status === "ready") applySettings(state, initialReadSequence);
    else if (!stopping && initialReadSequence >= latestAppliedSettingsSequence) {
      latestAppliedSettingsSequence = initialReadSequence;
      console.error(`Sprite Awake settings are invalid: ${state.error}`);
      applyPreferences(preferencesSchema.parse({}));
    }
  }).catch((error: unknown) => {
    if (stopping) return;
    console.error(`Could not read Sprite Awake settings: ${errorMessage(error)}`);
    if (initialReadSequence >= latestAppliedSettingsSequence) {
      latestAppliedSettingsSequence = initialReadSequence;
      applyPreferences(preferencesSchema.parse({}));
    }
  });

  server.handle(noteUserActivity, async (_input, { paseo }) => {
    agentRuntime.initialize(paseo);
    const result = await recordActivity();
    return { ...result, until: timestamp(activity.windows().interactionUntil) };
  });
  server.handle(readStatus, (_input, { paseo }) => {
    agentRuntime.initialize(paseo);
    const agent = manager.getStatus();
    const user = activityManager.getStatus();
    const windows = activity.windows();
    let state: typeof agent.state | "interactive" = agent.state;
    if (preferences.mode !== "off" && windows.interactionUntil !== null) {
      if (user.state === "error" || agent.state === "error") state = "error";
      else if (user.taskConfirmed && !["working", "always"].includes(state)) state = "interactive";
      else if (!user.taskConfirmed && !agent.taskConfirmed) state = user.state === "unavailable" ? "unavailable" : "checking";
    }
    const heartbeats = [agent.lastHeartbeat, user.lastHeartbeat].filter((value): value is string => value !== null).sort();
    return {
      ...agent, state, taskConfirmed: agent.taskConfirmed || user.taskConfirmed,
      lastHeartbeat: heartbeats.at(-1) ?? null,
      error: agent.error ?? user.error,
      interactionUntil: timestamp(windows.interactionUntil),
      activityTaskConfirmed: user.taskConfirmed, activityError: user.error,
    };
  });

  return async () => {
    stopping = true;
    unsubscribe();
    for (const remove of removers) remove();
    agentIntegration.cleanup();
    activityIntegration.cleanup();
    activity.cleanup();
    await agentRuntime.cleanup();
    tracker.cleanup();
    await Promise.allSettled([manager.shutdown(), activityManager.shutdown()]);
  };
}

function timestamp(value: number | null): string | null { return value === null ? null : new Date(value).toISOString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
