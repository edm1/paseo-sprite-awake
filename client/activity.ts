import { AppState, Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { noteUserActivity } from "../shared/settings.ts";
import { observeClientActivity, type BrowserDocument, type ClientActivitySource } from "./activity-observer.ts";

export function observeUserActivity(client: PluginClientContext): () => void {
  const send = (source: ClientActivitySource): void => {
    // No retry loop: reconnect and background polling are never themselves input.
    void client.rpc(noteUserActivity, { source }).catch(() => undefined);
  };
  if (Platform.OS === "web") {
    // DOM is intentionally absent from the cross-platform tsconfig. Only this
    // browser branch reads the structurally typed document global.
    const document = (globalThis as unknown as { document?: BrowserDocument }).document;
    return observeClientActivity({ send, ...(document ? { document } : {}) });
  }
  return observeClientActivity({ send, appState: {
    currentState: AppState.currentState,
    onChange: (callback) => { const subscription = AppState.addEventListener("change", callback); return () => subscription.remove(); },
  } });
}
