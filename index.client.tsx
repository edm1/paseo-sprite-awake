import type { PluginClientContext } from "@getpaseo/plugin/client";
import { observeUserActivity } from "./client/activity.ts";
import { noteUserActivity } from "./shared/settings.ts";
import { SpriteAwakeSettings } from "./client/settings.tsx";

export default function contribute(client: PluginClientContext) {
  const stopActivity = observeUserActivity(client);
  const removeAction = client.addCommandCenterItem({
    id: "keep-awake", title: "Keep Sprite awake for the activity window", icon: "Zap", context: "global",
    keywords: ["sleep", "wake", "sprite"],
    onSelect: async ({ rpc }) => { const result = await rpc(noteUserActivity, { source: "manual" });
      if (!result.protected) throw new Error("Sprite hold not confirmed. Check the mode, activity duration and Sprite diagnostic."); },
  });
  client.addSettingsScreen({
    id: "settings",
    title: "Sprite Awake",
    icon: "Zap",
    Component: SpriteAwakeSettings,
  });
  return () => { stopActivity(); removeAction(); };
}
