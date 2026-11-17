import { isElectronShell } from '@/lib/desktop';
import { desktopHostProbe, desktopHostsGet, desktopHostsSet, getDesktopHostApiUrl, normalizeHostUrl } from '@/lib/desktopHosts';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const CANDIDATE_REFRESH_DELAY_MS = 5_000;

const DIRECT_PROBE_HEADSTART_MS = 1_500;

let candidateRefreshInFlight = false;

const canonicalEndpoint = (value: string | null | undefined): string | null => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

const refreshDesktopHostCandidates = async (hostId: string): Promise<void> => {
  if (!isElectronShell() || candidateRefreshInFlight) return;
  const runtimeKey = `host:${hostId}`;
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
    if (lanUrls.length === 0) return;

    const nextApiUrl = currentApiUrl && lanUrls.includes(currentApiUrl) ? currentApiUrl : lanUrls[0];
    const nextEndpoint = canonicalEndpoint(nextApiUrl);
    if (nextEndpoint && nextEndpoint !== canonicalEndpoint(currentApiUrl)) {
      await desktopHostsSet({
        hosts: config.hosts.map((entry) => (entry.id === hostId ? { ...entry, apiUrl: nextApiUrl } : entry)),
        defaultHostId: config.defaultHostId,
        initialHostChoiceCompleted: config.initialHostChoiceCompleted,
      }).catch(() => undefined);
    }

    const storedConfig = await desktopHostsGet().catch(() => null);
    const storedHost = storedConfig?.hosts.find((entry) => entry.id === hostId) ?? null;
    if (!storedHost) return;
    if (!nextEndpoint || canonicalEndpoint(storedHost.apiUrl) !== nextEndpoint) return;

    const probe = await desktopHostProbe(nextApiUrl, {
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      expectedServerId: host.relay.serverId,
    }).catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));
    if (probe.status === 'unreachable' || probe.status === 'wrong-service' || probe.status === 'incompatible') return;
    if (getRuntimeKey() !== runtimeKey) return;
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

export const scheduleDesktopHostCandidateRefresh = (hostId: string): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void refreshDesktopHostCandidates(hostId).catch(() => undefined);
  }, CANDIDATE_REFRESH_DELAY_MS);
};

export const restoreDesktopRelayRuntime = async (
  targetHostId?: string,
  options?: { reconnectActive?: boolean },
): Promise<void> => {
  if (!isElectronShell()) return;
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return;
  const hostId = targetHostId || (config.defaultHostId !== 'local' ? config.defaultHostId : null);
  if (!hostId) return;
  const host = config.hosts.find((entry) => entry.id === hostId);
  if (!host?.relay) return;
  const runtimeKey = `host:${host.id}`;
  if (getRuntimeKey() === runtimeKey && !options?.reconnectActive) return;

  const switchToDirect = (url: string) => {
    switchRuntimeEndpoint({
      apiBaseUrl: url,
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      runtimeKey,
    });
  };
  const switchToRelay = () => {
    switchRuntimeEndpoint({
      apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      clientToken: host.clientToken || null,
      runtimeKey,
      relay: host.relay ?? undefined,
    });
    scheduleDesktopHostCandidateRefresh(host.id);
  };

  const directUrl = host.apiUrl ? normalizeHostUrl(getDesktopHostApiUrl(host)) : null;
  if (!directUrl) {
    switchToRelay();
    return;
  }

  const probeOk = (probe: { status: string }) =>
    probe.status !== 'unreachable' && probe.status !== 'wrong-service' && probe.status !== 'incompatible';
  const probePromise = desktopHostProbe(directUrl, {
    clientToken: host.clientToken || null,
    requestHeaders: host.requestHeaders || null,
    expectedServerId: host.relay.serverId,
  }).catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));

  const winner = await Promise.race([
    probePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DIRECT_PROBE_HEADSTART_MS)),
  ]);
  if (winner) {
    if (probeOk(winner)) {
      switchToDirect(directUrl);
      return;
    }
    switchToRelay();
    return;
  }

  switchToRelay();
  void probePromise.then((probe) => {
    if (!probeOk(probe)) return;
    if (getRuntimeKey() !== runtimeKey) return;
    switchToDirect(directUrl);
  });
};
