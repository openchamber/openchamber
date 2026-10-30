import { getActiveRelayTunnel } from './relay/runtime-tunnel';
import { buildRuntimeAuthHeaders } from './runtime-auth';
import { addRuntimeProxyHeaders, fetchBypassingRuntimeBridge, sanitizeHeadersForBrowser } from './runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged } from './runtime-switch';
import { getRuntimeUrlResolver } from './runtime-url';

type CleanupTransport = { fetch: typeof globalThis.fetch; baseUrl: string };
type Cleanup = (transport: CleanupTransport) => Promise<unknown>;
export type RuntimeCleanup = (cleanup: Cleanup) => Promise<void>;
const pending = new Map<string, Set<() => Promise<void>>>();
let unsubscribe: (() => void) | undefined;

async function captureCleanupTransport(expectedRuntimeKey: string): Promise<CleanupTransport> {
  const serviceRoot = getRuntimeUrlResolver().api('/api').replace(/\/api\/?$/, '');
  const relay = getActiveRelayTunnel();
  const headers = await buildRuntimeAuthHeaders();
  if (getRuntimeKey() !== expectedRuntimeKey) throw new Error('Runtime changed while preparing cleanup');

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const target = raw.startsWith('/') ? `${serviceRoot}${raw}` : raw;
    const merged = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(sanitizeHeadersForBrowser(init?.headers) ?? init?.headers).forEach((value, key) => merged.set(key, value));
    headers.forEach((value, key) => merged.set(key, value));
    if (relay) return relay.fetch(input, { ...init, headers: merged });
    addRuntimeProxyHeaders(target, merged);
    return fetchBypassingRuntimeBridge(input instanceof Request ? new Request(target, input) : target, { ...init, headers: merged });
  };
  return { fetch, baseUrl: serviceRoot };
}

/** Rollback stays with its creator. Failed or disconnected owners retry on return. */
export async function captureRuntimeCleanup(expectedRuntimeKey: string): Promise<RuntimeCleanup> {
  const direct = Boolean(getRuntimeApiBaseUrl()) && !getActiveRelayTunnel();
  const capturedTransport = await captureCleanupTransport(expectedRuntimeKey);

  return async (cleanup) => {
    let running = false;
    const attempt = async () => {
      if (running) return;
      running = true;
      try {
        // A relay or same-origin bridge only exists while its owner is active.
        const ownerActive = getRuntimeKey() === expectedRuntimeKey;
        if (!direct && !ownerActive) return;
        await cleanup(ownerActive ? await captureCleanupTransport(expectedRuntimeKey) : capturedTransport);
        pending.get(expectedRuntimeKey)?.delete(attempt);
        if (pending.get(expectedRuntimeKey)?.size === 0) pending.delete(expectedRuntimeKey);
        if (pending.size === 0) { unsubscribe?.(); unsubscribe = undefined; }
      } catch {
        // Keep the operation for the owner's next connection, without polling.
      } finally {
        running = false;
      }
    };
    const jobs = pending.get(expectedRuntimeKey) ?? new Set<() => Promise<void>>();
    jobs.add(attempt);
    pending.set(expectedRuntimeKey, jobs);
    unsubscribe ??= subscribeRuntimeEndpointChanged(({ runtimeKey }) => {
      for (const job of pending.get(runtimeKey) ?? []) void job();
    });
    await attempt();
  };
}
