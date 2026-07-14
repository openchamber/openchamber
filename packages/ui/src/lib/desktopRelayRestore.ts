import { isElectronShell } from '@/lib/desktop';
import { desktopHostProbe, desktopHostsGet, desktopHostsSet, getDesktopHostRuntimeSwitchOptions, normalizeHostUrl, probeDesktopHostTransportsForActivation } from '@/lib/desktopHosts';
import { adoptRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { DesktopHost, DesktopHostSelection, DesktopHostsConfig } from '@/lib/desktopHosts';

type DesktopRestoreDependencies = {
  isElectronShell: () => boolean;
  getHosts: () => Promise<DesktopHostsConfig>;
  selectTransport: (host: DesktopHost) => Promise<DesktopHostSelection>;
  getRuntimeKey: () => string;
  switchRuntime: typeof switchRuntimeEndpoint;
  windowOrigin: () => string;
};

// Let the post-switch bootstrap traffic settle before the background refresh.
const CANDIDATE_REFRESH_DELAY_MS = 5_000;

let candidateRefreshInFlight = false;

/**
 * Background candidate refresh for a relay-connected desktop host: ask the
 * server (over the live authenticated transport) for its CURRENT LAN addresses,
 * update the stored host's direct `apiUrl` if it moved (pairing-time addresses
 * go stale when DHCP reassigns the host machine's IP), then probe the fresh
 * address — identity-gated by the host's pinned relay serverId — and hot-switch
 * relay → direct when it is reachable. The runtime key stays `host:<id>`, so the
 * swap is a transport change, not an instance switch.
 *
 * This rewrites only the direct address of an ALREADY-TRUSTED host, learned from
 * that host itself over the E2EE tunnel pinned to its key — the token and trust
 * boundary are unchanged, so no user confirmation is required. An https apiUrl
 * (stable tunnel hostname) is never overwritten: the DHCP problem does not apply
 * to it and the server does not know its own public hostnames.
 */
export const refreshDesktopHostCandidates = async (hostId: string): Promise<void> => {
  if (!isElectronShell() || candidateRefreshInFlight) return;
  const runtimeKey = `host:${hostId}`;
  // The candidates fetch rides the active runtime's transport — only meaningful
  // while this host IS the active runtime.
  if (getRuntimeKey() !== runtimeKey) return;
  candidateRefreshInFlight = true;
  try {
    const config = await desktopHostsGet().catch(() => null);
    const host = config?.hosts.find((entry) => entry.id === hostId);
    if (!config || !host?.relay) return;
    const currentApiUrl = host.apiUrl ? normalizeHostUrl(host.apiUrl) : null;
    if (currentApiUrl && currentApiUrl.startsWith('https://')) return;

    const response = await runtimeFetch('/api/client-auth/connection/candidates').catch(() => null);
    if (!response?.ok) return;
    const payload = await response.json().catch(() => null) as { serverId?: unknown; candidates?: unknown } | null;
    // Identity gate: the refresh must come from the server this host entry is
    // pinned to; anything else (including old servers without serverId) is ignored.
    if (!payload || payload.serverId !== host.relay.serverId) return;
    const reported = Array.isArray(payload.candidates) ? payload.candidates : [];
    const lanUrls: string[] = [];
    for (const entry of reported) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== 'lan' || typeof record.url !== 'string') continue;
      const url = normalizeHostUrl(record.url);
      if (url && !lanUrls.includes(url)) lanUrls.push(url);
    }
    // Empty answer (loopback-only bind / scan failure) must not erase a stored
    // address — a stale one only costs a fast failed probe on the next start.
    if (lanUrls.length === 0) return;

    const nextApiUrl = currentApiUrl && lanUrls.includes(currentApiUrl) ? currentApiUrl : lanUrls[0];
    if (nextApiUrl !== currentApiUrl) {
      await desktopHostsSet({
        hosts: config.hosts.map((entry) => (entry.id === hostId ? { ...entry, apiUrl: nextApiUrl } : entry)),
        defaultHostId: config.defaultHostId,
        initialHostChoiceCompleted: config.initialHostChoiceCompleted,
      }).catch(() => undefined);
    }

    // We are on the relay for this host (the refresh call itself proves the
    // tunnel works) — if the fresh direct address answers AND proves the same
    // server identity, hot-switch to it.
    const probe = await desktopHostProbe(nextApiUrl, {
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      expectedServerId: host.relay.serverId,
    }).catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));
    if (probe.status === 'unreachable' || probe.status === 'wrong-service' || probe.status === 'incompatible') return;
    if (getRuntimeKey() !== runtimeKey) return; // user switched away meanwhile
    switchRuntimeEndpoint({
      apiBaseUrl: nextApiUrl,
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      runtimeKey,
    });
  } finally {
    candidateRefreshInFlight = false;
  }
};

/** Fire-and-forget wrapper: schedule the refresh after a relay switch settles. */
export const scheduleDesktopHostCandidateRefresh = (hostId: string): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void refreshDesktopHostCandidates(hostId).catch(() => undefined);
  }, CANDIDATE_REFRESH_DELAY_MS);
};

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
export const restoreDesktopRuntimeWithDependencies = async (
  dependencies: DesktopRestoreDependencies,
  targetHostId?: string,
): Promise<void> => {
  if (!dependencies.isElectronShell()) return;
  const config = await dependencies.getHosts().catch(() => null);
  if (!config) return;
  // An explicit target (a "new window for host X") wins over the default-host
  // relaunch logic.
  const hostId = targetHostId || (config.defaultHostId !== 'local' ? config.defaultHostId : null);
  if (!hostId) return;
  const host = config.hosts.find((entry) => entry.id === hostId);
  if (!host || (!host.relay && !host.directE2ee)) return;
  // Must match runtimeKeyForHost() in DesktopHostSwitcher so switch/resolve agree.
  const runtimeKey = `host:${host.id}`;
  if (dependencies.getRuntimeKey() === runtimeKey) return;

  const selection = await dependencies.selectTransport(host).catch(() => null);
  if (!selection?.transport) return;
  const options = getDesktopHostRuntimeSwitchOptions(host, selection.transport, dependencies.windowOrigin(), runtimeKey);
  if (!options) {
    if (selection.transport.kind === 'relay') selection.transport.tunnel?.close();
    return;
  }
  if (selection.transport.kind === 'relay' && selection.transport.tunnel) {
    adoptRelayTunnel(selection.transport.descriptor, selection.transport.tunnel);
  }
  dependencies.switchRuntime(options);
  if (selection.transport.kind === 'relay') {
    // Candidate refresh is meaningful only while the authenticated relay
    // transport is active; direct-E2EE descriptors do not expose LAN metadata.
    scheduleDesktopHostCandidateRefresh(host.id);
  }

  // A relay may win after the LAN head-start while the identity-gated direct
  // probe is still running. Adopt that direct leg only if this host remains the
  // active runtime when the late result arrives.
  if (selection.lateDirect && selection.directUrl) {
    void selection.lateDirect.then((probe) => {
      if (probe.status === 'unreachable' || probe.status === 'wrong-service' || probe.status === 'incompatible') return;
      if (dependencies.getRuntimeKey() !== runtimeKey) return;
      dependencies.switchRuntime({
        apiBaseUrl: selection.directUrl!,
        clientToken: host.clientToken || null,
        requestHeaders: host.requestHeaders || null,
        runtimeKey,
      });
    });
  }
};

export const restoreDesktopRelayRuntime = async (targetHostId?: string): Promise<void> =>
  restoreDesktopRuntimeWithDependencies({
    isElectronShell,
    getHosts: desktopHostsGet,
    selectTransport: probeDesktopHostTransportsForActivation,
    getRuntimeKey,
    switchRuntime: switchRuntimeEndpoint,
    windowOrigin: () => typeof window !== 'undefined' ? window.location.origin : '',
  }, targetHostId);
