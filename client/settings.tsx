import type { RpcOutput } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { awakeSettings, readStatus, noteUserActivity, type AwakeMode, type AwakePreferences } from "../shared/settings.ts";

type StatusResult = RpcOutput<typeof readStatus>;

const MODE_OPTIONS = [
  { label: "Auto", value: "auto" },
  { label: "Always", value: "always" },
  { label: "Off", value: "off" },
];

const STATUS_LABELS: Record<StatusResult["state"], string> = {
  checking: "Checking Sprite and agent state…",
  working: "Working — Sprite protected",
  grace: "Grace period — Sprite protected",
  idle: "Idle — sleep allowed",
  always: "Always awake — Sprite protected",
  off: "Off — sleep allowed",
  unavailable: "Unavailable — this host is not a supported Sprite",
  error: "Error — Sprite protection needs attention",
  interactive: "User activity window — Sprite protected",
};

export function SpriteAwakeSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(awakeSettings);
  const fetchStatus = useRpc(readStatus);
  const holdSprite = useRpc(noteUserActivity);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const refresh = async (): Promise<void> => {
      try {
        const next = await fetchStatus({});
        if (mounted) {
          setStatus(next);
          setStatusError(null);
        }
      } catch (error) {
        if (mounted) setStatusError(error instanceof Error ? error.message : String(error));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [fetchStatus]);

  const save = async (patch: Partial<AwakePreferences>): Promise<void> => {
    if (settings.status !== "ready") return;
    try {
      const saved = await settings.save({ ...settings.values, ...patch }, settings.revision);
      setStatusError(saved ? null : settings.saveError ?? "Could not save Sprite Awake settings");
    } catch (error) { setStatusError(error instanceof Error ? error.message : String(error)); }
  };
  const requestHold = async (): Promise<void> => {
    try {
      const result = await holdSprite({ source: "manual" });
      setStatusError(result.protected ? null : "Hold not confirmed. Check the mode, activity duration and Sprite diagnostic.");
      setStatus(await fetchStatus({}));
    } catch (error) { setStatusError(error instanceof Error ? error.message : String(error)); }
  };
  const disabled = settings.status !== "ready" || settings.saving;
  const durationOptions = [0, 1, 5, 10, 15, 30, 60].map((minutes) => ({
    label: minutes === 0 ? "Disabled" : `${minutes} minute${minutes === 1 ? "" : "s"}`, value: String(minutes),
  }));

  const foreground = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const currentMode = settings.status === "ready" ? settings.values.mode : "auto";
  const currentState = status?.state ?? "checking";
  const heartbeat = status?.lastHeartbeat
    ? new Date(status.lastHeartbeat).toLocaleString()
    : "Not yet confirmed";

  return (
    <View style={{ gap: 20, padding: 20 }}>
      <SettingsSection title="Sprite status">
        <SettingsCard>
          <SettingsRow label={STATUS_LABELS[currentState]}>
            <Text style={muted}>
              {status?.activeAgents ?? 0} active agent{status?.activeAgents === 1 ? "" : "s"}
              {status?.taskConfirmed ? " · keep-awake task confirmed" : ""}
            </Text>
          </SettingsRow>
          {status?.lastHeartbeat ? (
            <SettingsRow label="Last successful heartbeat" hint={heartbeat} />
          ) : null}
          {status?.interactionUntil ? <SettingsRow label="User activity hold until" hint={new Date(status.interactionUntil).toLocaleString()} /> : null}
          {status?.error || statusError ? (
            <SettingsRow label="Diagnostic" error={status?.error ?? statusError ?? null} />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Mode"
        info="Auto protects the Sprite while Paseo reports active work or recent user activity. The last agent finishing starts a 60-second grace period."
      >
        <SettingsCard>
          <SettingsSelect
            label="Sprite sleep management"
            hint="Auto is the default on supported Sprites."
            value={currentMode}
            options={MODE_OPTIONS}
            disabled={settings.status !== "ready" || settings.saving}
            onValueChange={(value) => { if (isAwakeMode(value)) void save({ mode: value }); }}
            error={settings.status === "ready" ? settings.saveError ?? null : null}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="User activity" info="Quiet connections, relay presence and status polling do not extend the activity window. Zero disables it.">
        <SettingsCard>
          <SettingsSelect label="User activity duration" hint="Sliding window after browser input, workspace/agent actions or a mobile return to foreground."
            value={String(settings.status === "ready" ? settings.values.interactionHoldMinutes : 10)} options={durationOptions}
            disabled={disabled} onValueChange={(value) => void save({ interactionHoldMinutes: Number(value) })} />
          <SettingsAction label="Keep awake now" hint="Useful on Android while browsing or preparing a workspace. Uses the user activity duration."
            actionLabel="Keep awake" disabled={disabled || currentMode === "off"} onPress={() => void requestHold()} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Waiting for input">
        <SettingsCard>
          <SettingsSelect
            label="Waiting for input timeout"
            hint="In Auto mode, stop counting unanswered permission requests and questions after this time, then allow the 60-second grace period. Always mode stays awake."
            value={String(settings.status === "ready" ? settings.values.waitingTimeoutMinutes : 10)}
            options={[1, 5, 10, 15, 30, 60, 0].map((minutes) => ({ label: minutes === 0 ? "No timeout (stay awake)" : `${minutes} minute${minutes === 1 ? "" : "s"}`, value: String(minutes) }))}
            disabled={settings.status !== "ready" || settings.saving}
            onValueChange={(value) => void save({ waitingTimeoutMinutes: Number(value) })}
            error={settings.status === "ready" ? settings.saveError ?? null : null}
          />
        </SettingsCard>
      </SettingsSection>
      <Text style={foreground}>
        The plugin releases only its two owned tasks. Fly.io suspends the Sprite when its other normal idle conditions are also met.
      </Text>
    </View>
  );
}

function isAwakeMode(value: string): value is AwakeMode {
  return value === "auto" || value === "always" || value === "off";
}
