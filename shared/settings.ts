import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z, type infer as ZodInfer } from "zod";

export const preferencesSchema = z.object({
  interactionHoldMinutes: z.number().int().min(0).max(60).default(10),
  waitingTimeoutMinutes: z.number().int().min(0).max(60).default(10),
  mode: z.enum(["auto", "always", "off"]).default("auto"),
});

export type AwakePreferences = ZodInfer<typeof preferencesSchema>;

export const awakeSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: preferencesSchema,
});

export const readStatus = defineRpc({
  name: "sprite-awake.status",
  input: z.object({}),
  output: z.object({
    mode: z.enum(["auto", "always", "off"]),
    state: z.enum(["checking", "working", "grace", "idle", "always", "off", "unavailable", "error", "interactive"]),
    activeAgents: z.number().int().nonnegative(),
    taskConfirmed: z.boolean(),
    lastHeartbeat: z.string().nullable(),
    error: z.string().nullable(),
    interactionUntil: z.string().nullable(),
    activityTaskConfirmed: z.boolean(),
    activityError: z.string().nullable(),
  }),
});

export type AwakeMode = "auto" | "always" | "off";

export const noteUserActivity = defineRpc({
  name: "sprite-awake.user-activity",
  input: z.object({ source: z.enum(["web-input", "app-foreground", "manual"]) }),
  output: z.object({ protected: z.boolean(), until: z.string().nullable() }),
});
