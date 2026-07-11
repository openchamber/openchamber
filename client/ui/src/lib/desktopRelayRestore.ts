import { isElectronShell } from '@/lib/desktop';
import { desktopHostProbe, desktopHostsGet, getDesktopHostApiUrl, normalizeHostUrl } from '@/lib/desktopHosts';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

/**
 * On desktop startup, reconnect a relay-capable default host. The Electron
 * shell boots the LOCAL UI for any host that carries a relay leg and defers
 * transport selection to the renderer: here we probe the direct address first
 * (cheap, preferred on the home network) and fall back to the E2EE tunnel via
 * switchRuntimeEndpoint({ relay }) — the multi-transport model mobile uses.
 * Direct-only hosts never reach this path (the shell injects their
 * apiBaseUrl/token as window globals before render).
 *
 * Safe to call unconditionally; it is a no-op outside the Electron shell and when
 * the default host is local or already active.
 */
export const restoreDesktopRelayRuntime = async (targetHostId?: string): Promise<void> => {
  if (!isElectronShell()) return;
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return;
  // An explicit target (a "new window for host X") wins over the default-host
  // relaunch logic.
  const hostId = targetHostId || (config.defaultHostId !== 'local' ? config.defaultHostId : null);
  if (!hostId) return;
  const host = config.hosts.find((entry) => entry.id === hostId);
  if (!host?.relay) return;
  // Must match runtimeKeyForHost() in DesktopHostSwitcher so switch/resolve agree.
  const runtimeKey = `host:${host.id}`;
  if (getRuntimeKey() === runtimeKey) return;

  const directUrl = host.apiUrl ? normalizeHostUrl(getDesktopHostApiUrl(host)) : null;
  if (directUrl) {
    const probe = await desktopHostProbe(directUrl, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null })
      .catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));
    if (probe.status !== 'unreachable' && probe.status !== 'wrong-service' && probe.status !== 'incompatible') {
      switchRuntimeEndpoint({
        apiBaseUrl: directUrl,
        clientToken: host.clientToken || null,
        requestHeaders: host.requestHeaders || null,
        runtimeKey,
      });
      return;
    }
  }
  switchRuntimeEndpoint({
    apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
    clientToken: host.clientToken || null,
    runtimeKey,
    relay: host.relay,
  });
};
