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
import { LOCAL_HOST_ID, buildLocalDesktopHost } from '@/lib/desktopCurrentHost';

export type DesktopHostStatus = {
  status: HostProbeResult['status'];
  latencyMs: number;
  /** Which transport the successful probe used (multi-transport hosts). */
  via?: 'relay';
};

/** Reachability by instance id. */
type DesktopHostStatusMap = Record<string, DesktopHostStatus>;

type DesktopHostStatusSnapshot = {
  byHostId: Readonly<DesktopHostStatusMap>;
  /** True while any probe run is in flight, for the refresh spinner. */
  isProbing: boolean;
};

/**
 * Reachability of every configured instance, owned outside the switcher UI.
 *
 * The switcher used to hold this in component state, which made the dropdown
 * the only thing that could ever learn an instance's status: every open started
 * from nothing and showed "Checking" on rows the app had already answered for —
 * including the instance the app was connected to and actively talking to.
 *
 * Keeping it here lets startup warm the statuses before the user opens
 * anything, and lets a re-probe replace values in place instead of blanking
 * them first.
 */
const statuses = new Map<string, DesktopHostStatus>();
// Startup warm-up, opening the switcher and the refresh button can all be in
// flight at once, and a probe's duration varies by an order of magnitude
// between a loopback host and a relay host working through tunnel retries.
// Without ordering, a slow older run lands last and replaces a fresh "ok" with
// its own stale "unreachable". Each host remembers which run owns its status.
let probeRunSequence = 0;
const owningRunByHostId = new Map<string, number>();
let activeProbeRuns = 0;
let snapshot: DesktopHostStatusSnapshot = { byHostId: {}, isProbing: false };
const listeners = new Set<() => void>();

const publishSnapshot = (): void => {
  // `useSyncExternalStore` compares snapshots by identity, so each mutation
  // publishes a fresh one rather than handing out the live map.
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

/**
 * Record a status learned outside a probe run — the switch flow probes too, and
 * its result is the freshest thing anyone has, so it takes ownership away from
 * any probe run still running for that host.
 */
export const setDesktopHostStatus = (hostId: string, status: DesktopHostStatus): void => {
  owningRunByHostId.set(hostId, ++probeRunSequence);
  setStatus(hostId, status);
};

/**
 * Forget instances that are no longer configured. Called with the authoritative
 * host list, never with a partially loaded one — dropping entries on a list
 * that has not finished loading is what made every dropdown open start blank.
 */
export const pruneDesktopHostStatuses = (configuredHostIds: readonly string[]): void => {
  const keep = new Set([LOCAL_HOST_ID, ...configuredHostIds]);
  let changed = false;
  for (const hostId of Array.from(statuses.keys())) {
    if (keep.has(hostId)) continue;
    statuses.delete(hostId);
    owningRunByHostId.delete(hostId);
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
    // `via` is what renders the "· Relay" suffix, so it marks a reachable host
    // only — a failed relay leg says nothing about which transport would work.
    if (res.status === 'ok') status.via = 'relay';
    return status;
  };

  // Relay-only host: no HTTP address — probe through the E2EE tunnel.
  if (host.relay && !host.apiUrl) return probeRelayLeg();

  const url = normalizeHostUrl(isElectronShell() ? getDesktopHostApiUrl(host) : host.url);
  if (!url) return { status: 'unreachable', latencyMs: 0 };

  const res = await desktopHostProbe(url, { clientToken: clientToken || null, requestHeaders: host.requestHeaders || null })
    .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
  // Multi-transport host away from its network: the direct leg fails but the
  // relay may still reach it.
  if (isBlockedProbeStatus(res.status) && host.relay) {
    const relayStatus = await probeRelayLeg();
    if (relayStatus.status === 'ok') return relayStatus;
  }
  return { status: res.status, latencyMs: res.latencyMs };
};

/**
 * Probe every given instance, publishing each result the moment it lands.
 * Waiting for the slowest probe would hold answered rows on "Checking" beside
 * one host still working through its relay tunnel retries.
 */
export const probeDesktopHosts = async (hosts: readonly DesktopHost[]): Promise<void> => {
  if (!isDesktopShell()) return;
  const run = ++probeRunSequence;
  for (const host of hosts) owningRunByHostId.set(host.id, run);
  activeProbeRuns += 1;
  publishSnapshot();
  try {
    const localClientToken = await getLocalClientToken();
    await Promise.all(hosts.map(async (host) => {
      const status = await probeHost(host, localClientToken);
      // A newer run (or a switch) claimed this host while we were probing.
      if (owningRunByHostId.get(host.id) !== run) return;
      setStatus(host.id, status);
    }));
  } finally {
    activeProbeRuns -= 1;
    publishSnapshot();
  }
};

let warmUpStarted = false;

/**
 * Learn every instance's status once at startup, so the switcher opens on real
 * values instead of probing for the first time under the user's cursor.
 *
 * Deliberately after the app's own bootstrap: this is background work, and the
 * direct legs go through the Electron main process while relay legs open their
 * own WebSocket, so neither shares the renderer's connection pool with session
 * traffic — but the machine's network is still busiest right at launch.
 */
export const warmDesktopHostStatuses = async (): Promise<void> => {
  if (warmUpStarted || !isDesktopShell()) return;
  warmUpStarted = true;
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return;
  pruneDesktopHostStatuses(config.hosts.map((host) => host.id));
  await probeDesktopHosts([buildLocalDesktopHost(config.localOrigin), ...config.hosts]);
};
