export type ClientActivitySource = "web-input" | "app-foreground";
export interface BrowserEvent { readonly isTrusted: boolean }
export interface BrowserDocument {
  readonly visibilityState: string;
  addEventListener(type: string, callback: (event: BrowserEvent) => void, capture: boolean): void;
  removeEventListener(type: string, callback: (event: BrowserEvent) => void, capture: boolean): void;
}
export interface AppStatePort {
  readonly currentState: string | null;
  onChange(callback: (state: string) => void): () => void;
}
export interface ClientActivityOptions {
  document?: BrowserDocument;
  appState?: AppStatePort;
  send: (source: ClientActivitySource) => void;
  now?: () => number;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
}

/** Input-driven adapter. There is no connection heartbeat or initial-mount signal. */
export function observeClientActivity(options: ClientActivityOptions): () => void {
  let stopped = false;
  let lastSent = -Infinity;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? globalThis;
  const send = (source: ClientActivitySource): void => {
    if (stopped) return;
    lastSent = now();
    options.send(source);
  };
  const document = options.document;
  if (document) {
    const input = (event: BrowserEvent): void => {
      if (!event.isTrusted || document.visibilityState !== "visible" || stopped) return;
      if (now() - lastSent >= 5_000) send("web-input");
      else if (pending === null) pending = timers.setTimeout(() => {
        pending = null;
        if (document.visibilityState === "visible") send("web-input");
      }, 5_000 - (now() - lastSent));
    };
    const events = ["pointerdown", "keydown", "wheel"];
    for (const event of events) document.addEventListener(event, input, true);
    return () => {
      stopped = true;
      if (pending !== null) timers.clearTimeout(pending);
      for (const event of events) document.removeEventListener(event, input, true);
    };
  }
  const appState = options.appState;
  if (appState) {
    let previous = appState.currentState;
    const remove = appState.onChange((next) => {
      if (next === "active" && (previous === "background" || previous === "inactive")) send("app-foreground");
      previous = next;
    });
    return () => { stopped = true; remove(); };
  }
  return () => { stopped = true; };
}
