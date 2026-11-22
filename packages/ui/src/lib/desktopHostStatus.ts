import { isDesktopShell, isElectronShell } from '@/lib/desktop';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopLocalClientTokenGet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  probeRelayDesktopHost,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { LOCAL_HOST_ID, withLocalDesktopHost } from '@/lib/desktopCurrentHost';

export type DesktopHostStatus = {
  status: HostProbeResult['status'];
  latencyMs: number;
  via?: 'relay';
};

type DesktopHostStatusMap = Record<string, DesktopHostStatus>;

type DesktopHostStatusSnapshot = {
  byHostId: Readonly<DesktopHostStatusMap>;
  isProbing: boolean;
};

const statuses = new Map<string, DesktopHostStatus>();
let probeRunSequence = 0;
const owningRunByHostId = new Map<string, number>();
const pendingHostIds = new Set<string>();
let activeProbeRuns = 0;
let snapshot: DesktopHostStatusSnapshot = { byHostId: {}, isProbing: false };
const listeners = new Set<() => void>();

const publishSnapshot = (): void => {
  snapshot = { byHostId: Object.fromEntries(statuses), isProbing: activeProbeRuns > 0 };
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A subscriber throwing must not stop the others.
    }
  }
};

export const subscribeDesktopHostStatuses = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getDesktopHostStatusSnapshot = (): DesktopHostStatusSnapshot => snapshot;

const setStatus = (hostId: string, status: DesktopHostStatus): void => {
  statuses.set(hostId, status);
  publishSnapshot();
};

export const setDesktopHostStatus = (hostId: string, status: DesktopHostStatus): void => {
  owningRunByHostId.set(hostId, ++probeRunSequence);
  pendingHostIds.delete(hostId);
  setStatus(hostId, status);
};

export const isDesktopHostStatusPending = (hostId: string): boolean => pendingHostIds.has(hostId);

export const pruneDesktopHostStatuses = (configuredHostIds: readonly string[]): void => {
  const keep = new Set([LOCAL_HOST_ID, ...configuredHostIds]);
  let changed = false;
  for (const hostId of Array.from(statuses.keys())) {
    if (keep.has(hostId)) continue;
    statuses.delete(hostId);
    owningRunByHostId.delete(hostId);
    pendingHostIds.delete(hostId);
    changed = true;
  }
  if (changed) publishSnapshot();
};

const isBlockedProbeStatus = (status: HostProbeResult['status']): boolean =>
  status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';

const getLocalClientToken = async (): Promise<string> => {
  if (!isElectronShell()) return '';
  return desktopLocalClientTokenGet().catch(() => '');
};

const probeHost = async (host: DesktopHost, localClientToken: string): Promise<DesktopHostStatus> => {
  const clientToken = host.id === LOCAL_HOST_ID ? localClientToken : (host.clientToken || '');
  const probeRelayLeg = async (): Promise<DesktopHostStatus> => {
    const res = await probeRelayDesktopHost(host.relay!, { clientToken, requestHeaders: host.requestHeaders || null })
      .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
    const status: DesktopHostStatus = { status: res.status, latencyMs: res.latencyMs };
    if (res.status === 'ok') status.via = 'relay';
    return status;
  };

  if (host.relay && !host.apiUrl) return probeRelayLeg();

  const url = normalizeHostUrl(isElectronShell() ? getDesktopHostApiUrl(host) : host.url);
  if (!url) return { status: 'unreachable', latencyMs: 0 };

  const res = await desktopHostProbe(url, {
    clientToken: clientToken || null,
    requestHeaders: host.requestHeaders || null,
    expectedServerId: host.relay?.serverId ?? null,
  })
    .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
  if (isBlockedProbeStatus(res.status) && host.relay) {
    const relayStatus = await probeRelayLeg();
    if (relayStatus.status === 'ok' || relayStatus.status === 'relay-limit') return relayStatus;
  }
  return { status: res.status, latencyMs: res.latencyMs };
};

export const probeDesktopHosts = async (hosts: readonly DesktopHost[]): Promise<void> => {
  if (!isDesktopShell()) return;
  const run = ++probeRunSequence;
  for (const host of hosts) {
    owningRunByHostId.set(host.id, run);
    pendingHostIds.add(host.id);
  }
  activeProbeRuns += 1;
  publishSnapshot();
  try {
    const localClientToken = await getLocalClientToken();
    await Promise.all(hosts.map(async (host) => {
      const status = await probeHost(host, localClientToken);
      if (owningRunByHostId.get(host.id) !== run) return;
      pendingHostIds.delete(host.id);
      setStatus(host.id, status);
    }));
  } finally {
    for (const host of hosts) {
      if (owningRunByHostId.get(host.id) === run) pendingHostIds.delete(host.id);
    }
    activeProbeRuns -= 1;
    publishSnapshot();
  }
};

let warmUpStarted = false;

export const warmDesktopHostStatuses = async (): Promise<void> => {
  if (warmUpStarted || !isDesktopShell()) return;
  warmUpStarted = true;
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return;
  pruneDesktopHostStatuses(config.hosts.map((host) => host.id));
  await probeDesktopHosts(withLocalDesktopHost(config.hosts, config.localOrigin));
};
