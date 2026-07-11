export type ConfigChangeScope = "agents" | "providers" | "commands" | "skills" | "all";

export interface ConfigChangeEvent {
  scopes: ConfigChangeScope[];
  source?: string;
  timestamp: number;
}

type ConfigChangeListener = (event: ConfigChangeEvent) => void | Promise<void>;

const listeners = new Set<ConfigChangeListener>();

export function subscribeToConfigChanges(
  listener: ConfigChangeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitConfigChange(
  scopes: ConfigChangeScope | ConfigChangeScope[],
  options?: { source?: string },
): void {
  const normalized = Array.isArray(scopes) ? scopes : [scopes];
  const uniqueScopes = Array.from(new Set(normalized));

  if (uniqueScopes.length === 0) {
    return;
  }

  if (uniqueScopes.includes("all")) {
    uniqueScopes.splice(0, uniqueScopes.length, "all");
  }

  const event: ConfigChangeEvent = {
    scopes: uniqueScopes,
    source: options?.source,
    timestamp: Date.now(),
  };

  for (const listener of listeners) {
    try {
      const result = listener(event);
      if (result instanceof Promise) {
        result.catch((error) => {
          console.error("[ConfigSync] Async listener failed:", error);
        });
      }
    } catch (error) {
      console.error("[ConfigSync] Listener threw:", error);
    }
  }
}

export function scopeMatches(
  event: ConfigChangeEvent,
  scope: ConfigChangeScope,
): boolean {
  return event.scopes.includes("all") || event.scopes.includes(scope);
}
