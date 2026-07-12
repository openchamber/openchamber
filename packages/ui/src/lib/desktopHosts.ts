import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';
import { createRelayTunnelClient, type RelayTunnelFailureClassification } from '@/lib/relay/tunnel-client';
import { createDirectE2eeTunnelClient } from '@/lib/relay/direct-e2ee-tunnel-client';
import { normalizeDirectE2eeCandidate } from '@/lib/connectionPayload';

type DesktopInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const isReservedRequestHeaderName = (name: string): boolean => name.trim().toLowerCase() === 'authorization';

const sanitizeRequestHeaders = (headers: unknown): Record<string, string> | undefined => {
  if (!isRecord(headers)) return undefined;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.trim();
    const headerValue = typeof value === 'string' ? value.trim() : '';
    if (!name || !headerValue || /[\r\n:]/.test(name) || /[\r\n]/.test(headerValue)) continue;
    if (isReservedRequestHeaderName(name)) continue;
    next[name] = headerValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

/**
 * Private-relay reachability for a host. A host may carry this ALONGSIDE a
 * direct `apiUrl` (multi-transport: direct on the home network, E2EE tunnel
 * away — mirrors the mobile connection model) or as its only transport.
 * `hostEncPubJwk` is the trust anchor that pins the tunnel to the real server.
 * The relay admission `grant` is a one-time pairing artifact and is
 * intentionally NOT persisted — steady-state relay connections route by
 * `serverId` alone.
 */
export type DesktopHostRelay = {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
};

export type DesktopHostDirectE2ee = {
  wssUrl: string;
  hostEncPubJwk: JsonWebKey;
};

export type DesktopHost = {
  id: string;
  label: string;
  /** Legacy/UI URL. During migration this may equal apiUrl. For relay hosts this is a display-only `relay://<serverId>` pseudo-URL. */
  url: string;
  /** API endpoint used by packaged Electron UI for this instance. Absent for relay-only hosts. */
  apiUrl?: string;
  /** Remote client bearer token for packaged-client API access. */
  clientToken?: string;
  /** Extra headers for desktop runtime API requests. */
  requestHeaders?: Record<string, string>;
  /** When set, this host is reached over the private relay tunnel. */
  relay?: DesktopHostRelay;
  directE2ee?: DesktopHostDirectE2ee;
};

/** Display-only pseudo-URL for a relay host (never fetched). */
export const relayHostDisplayUrl = (serverId: string): string => `relay://${serverId}`;

const parseHostRelay = (value: unknown): DesktopHostRelay | null => {
  if (!isRecord(value)) return null;
  const relayUrl = readString(value, 'relayUrl') || readString(value, 'relay_url');
  const serverId = readString(value, 'serverId') || readString(value, 'server_id');
  const jwk = value.hostEncPubJwk ?? value.host_enc_pub_jwk;
  if (!relayUrl || !serverId || !isRecord(jwk)) return null;
  return { relayUrl, serverId, hostEncPubJwk: jwk as JsonWebKey };
};

const parseHostDirectE2ee = (value: unknown): DesktopHostDirectE2ee | null => {
  const normalized = normalizeDirectE2eeCandidate(isRecord(value) ? { type: 'direct-e2ee', ...value } : value);
  return normalized ? { wssUrl: normalized.wssUrl, hostEncPubJwk: normalized.hostEncPubJwk } : null;
};

export const directE2eeHostFingerprint = (descriptor: DesktopHostDirectE2ee): string => {
  const key = descriptor.hostEncPubJwk;
  return `p256:${key.x || ''}.${key.y || ''}`;
};

export type DesktopHostsConfig = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  initialHostChoiceCompleted: boolean;
  localOrigin?: string | null;
};

/** Backward-compatible input type — callers may omit `initialHostChoiceCompleted`. */
export type DesktopHostsConfigInput = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  initialHostChoiceCompleted?: boolean;
  localClientToken?: string | null;
};

export type HostProbeResult = {
  status: 'ok' | 'auth' | 'update-recommended' | 'incompatible' | 'wrong-service' | 'unreachable';
  latencyMs: number;
  failureClassification?: RelayTunnelFailureClassification;
};

export type DesktopHostTransport =
  | { kind: 'direct'; url: string }
  | { kind: 'direct-e2ee'; descriptor: DesktopHostDirectE2ee }
  | { kind: 'relay'; descriptor: DesktopHostRelay; tunnel?: ReturnType<typeof createRelayTunnelClient> };

export type DesktopHostSelection = {
  probe: HostProbeResult;
  transport: DesktopHostTransport | null;
  lateDirect?: Promise<HostProbeResult>;
  directUrl?: string;
};

export type DesktopHostRuntimeSwitchOptions = {
  apiBaseUrl: string;
  clientToken: string | null;
  runtimeKey: string;
  requestHeaders?: Record<string, string> | null;
  relay?: DesktopHostRelay;
  tunnel?: { type: 'direct-e2ee' } & DesktopHostDirectE2ee;
};

export const shouldDelegateDesktopHostActivation = (isLocalDesktopOrigin: boolean): boolean => !isLocalDesktopOrigin;

export const getDesktopHostRuntimeSwitchOptions = (
  host: DesktopHost,
  transport: DesktopHostTransport,
  localUiOrigin: string,
  runtimeKey: string,
): DesktopHostRuntimeSwitchOptions | null => {
  if (transport.kind === 'direct') {
    return { apiBaseUrl: transport.url, clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null, runtimeKey };
  }
  if (transport.kind === 'direct-e2ee') {
    if (!host.clientToken) return null;
    return { apiBaseUrl: localUiOrigin, clientToken: host.clientToken || null, runtimeKey, tunnel: { type: 'direct-e2ee', ...transport.descriptor } };
  }
  return { apiBaseUrl: localUiOrigin, clientToken: host.clientToken || null, runtimeKey, relay: transport.descriptor };
};

export type DesktopHostProbeDependencies = {
  probeDirect: (url: string, options: { clientToken: string | null; requestHeaders: Record<string, string> | null; expectedServerId?: string | null }) => Promise<HostProbeResult>;
  probeDirectE2ee: (descriptor: DesktopHostDirectE2ee, clientToken: string | null) => Promise<HostProbeResult>;
  probeRelay: (descriptor: DesktopHostRelay, clientToken: string | null) => Promise<HostProbeResult & { tunnel?: ReturnType<typeof createRelayTunnelClient> }>;
};

export type DesktopHostUrlResolution = {
  persistedUrl: string;
  redeemUrl: string | null;
  kind: 'normal-host' | 'tunnel-connect-link';
};

const SENSITIVE_QUERY_KEY = /^(t|.*(?:token|auth|secret|api).*)$/i;

export const normalizeHostUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return trimmed.split('#')[0] || null;
  } catch {
    return null;
  }
};

export const resolveDesktopHostUrl = (raw: string): DesktopHostUrlResolution | null => {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/connect' && url.searchParams.has('t')) {
      return {
        persistedUrl: url.origin,
        redeemUrl: url.toString(),
        kind: 'tunnel-connect-link',
      };
    }
  } catch {
    return null;
  }

  return {
    persistedUrl: normalized,
    redeemUrl: null,
    kind: 'normal-host',
  };
};

export const redactSensitiveUrl = (raw: string): string => {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) {
    return raw;
  }

  try {
    const url = new URL(normalized);
    // Redact embedded credentials (userinfo) to prevent leaking user:pass
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }

    const keys = Array.from(new Set(Array.from(url.searchParams.keys())));
    for (const key of keys) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch {
    return normalized;
  }
};

export const locationMatchesHost = (locationHref: string, hostUrl: string): boolean => {
  const normalizedCurrent = normalizeHostUrl(locationHref);
  const normalizedHost = normalizeHostUrl(hostUrl);
  if (!normalizedCurrent || !normalizedHost) {
    return false;
  }

  try {
    const current = new URL(normalizedCurrent);
    const host = new URL(normalizedHost);
    if (current.origin !== host.origin) {
      return false;
    }

    if (host.search && current.search !== host.search) {
      return false;
    }

    const hostPath = host.pathname.length > 1 ? host.pathname.replace(/\/+$/, '') : host.pathname;
    const currentPath = current.pathname.length > 1 ? current.pathname.replace(/\/+$/, '') : current.pathname;
    if (hostPath === '/') {
      return true;
    }
    return currentPath === hostPath || currentPath.startsWith(`${hostPath}/`);
  } catch {
    return false;
  }
};

const readString = (obj: Record<string, unknown>, key: string): string | null => {
  const val = obj[key];
  return typeof val === 'string' ? val : null;
};

const readNumber = (obj: Record<string, unknown>, key: string): number | null => {
  const val = obj[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
};

const parseHost = (value: unknown): DesktopHost | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, 'id');
  const label = readString(value, 'label');
  const url = readString(value, 'url');
  const apiUrl = readString(value, 'apiUrl') || readString(value, 'api_url');
  const clientToken = readString(value, 'clientToken') || readString(value, 'client_token');
  const requestHeaders = sanitizeRequestHeaders(value.requestHeaders);
  const relay = parseHostRelay(value.relay);
  const directE2ee = parseHostDirectE2ee(value.directE2ee ?? value.direct_e2ee);
  if (!id || !label || !url || (!apiUrl && !relay && !directE2ee && !normalizeHostUrl(url))) return null;
  return {
    id,
    label,
    url,
    ...(apiUrl ? { apiUrl } : {}),
    ...(clientToken ? { clientToken } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
    ...(relay ? { relay } : {}),
    ...(directE2ee ? { directE2ee } : {}),
  };
};

export const getDesktopHostApiUrl = (host: DesktopHost): string => {
  return normalizeHostUrl(host.apiUrl || host.url) || host.apiUrl || host.url;
};

const getInvoke = (): DesktopInvoke | null => {
  if (!hasDesktopInvoke()) return null;
  return (command, args) => invokeDesktop(command, args) as Promise<unknown>;
};

export const desktopHostsGet = async (): Promise<DesktopHostsConfig> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { hosts: [], defaultHostId: 'local', initialHostChoiceCompleted: false };
  }

  const raw = await invoke('desktop_hosts_get');
  if (!isRecord(raw)) {
    return { hosts: [], defaultHostId: null, initialHostChoiceCompleted: false };
  }

  const hostsRaw = raw.hosts;
  const hosts = Array.isArray(hostsRaw)
    ? hostsRaw.map(parseHost).filter((h): h is DesktopHost => Boolean(h))
    : [];

  const defaultHostId =
    readString(raw, 'defaultHostId') ||
    readString(raw, 'default_host_id') ||
    readString(raw, 'defaultHostID');

  const initialHostChoiceCompleted =
    raw.initialHostChoiceCompleted === true || raw.initial_host_choice_completed === true;
  const localOrigin = readString(raw, 'localOrigin') || readString(raw, 'local_origin');

  return { hosts, defaultHostId, initialHostChoiceCompleted, localOrigin };
};

export const desktopHostsSet = async (config: DesktopHostsConfigInput): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  const input: Record<string, unknown> = {
    hosts: config.hosts,
    defaultHostId: config.defaultHostId,
    initialHostChoiceCompleted: config.initialHostChoiceCompleted,
  };
  if (config.localClientToken !== undefined) {
    input.localClientToken = config.localClientToken;
  }
  await invoke('desktop_hosts_set', {
    input,
  });
};

export const desktopLocalClientTokenGet = async (): Promise<string> => {
  const invoke = getInvoke();
  if (!invoke) return '';
  const raw = await invoke('desktop_local_client_token_get').catch(() => null);
  return typeof raw === 'string' ? raw.trim() : '';
};

/**
 * Stable per-install identifier for this desktop. Used as the client dedupe key
 * so re-pairing or re-authenticating this desktop reuses its single device
 * record on a server instead of piling up duplicates. Empty string when not in
 * the desktop shell.
 */
export const desktopInstallIdGet = async (): Promise<string> => {
  const invoke = getInvoke();
  if (!invoke) return '';
  const raw = await invoke('desktop_install_id_get').catch(() => null);
  return typeof raw === 'string' ? raw.trim() : '';
};

const RELAY_PROBE_TIMEOUT_MS = 8_000;
const RELAY_RACE_HEADSTART_MS = 1_500;

/**
 * Reachability check for a relay host: open a throwaway E2EE tunnel and hit
 * /health. Relay hosts have no HTTP address for `desktopHostProbe`. Hard
 * timeout: a ghost relay registration (relay lost the host, host doesn't know)
 * leaves the tunnel in `connecting` forever — the probe must report
 * unreachable instead of hanging every status/switch flow with it.
 */
export const probeRelayDesktopHost = async (
  relay: DesktopHostRelay,
  // With `keepTunnel`, an 'ok' probe RETURNS its live tunnel (the caller owns
  // it — typically adopting it as the runtime tunnel, skipping a second
  // WebSocket connect + E2EE handshake); every other outcome closes it.
  optionsOrClientToken?: { keepTunnel?: boolean; clientToken?: string | null } | string | null,
): Promise<HostProbeResult & { tunnel?: ReturnType<typeof createRelayTunnelClient> }> => {
  const options = typeof optionsOrClientToken === 'object'
    ? optionsOrClientToken
    : { clientToken: optionsOrClientToken };
  const tunnel = createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
  });
  const startedAt = Date.now();
  let keep = false;
  try {
    const response = await Promise.race([
      tunnel.fetch('/health'),
      new Promise<null>((resolve) => {
        const timer = window.setTimeout(() => resolve(null), RELAY_PROBE_TIMEOUT_MS);
        if (typeof timer !== 'number' && typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as unknown as { unref: () => void }).unref();
        }
      }),
    ]);
    if (!response?.ok) return { status: 'unreachable', latencyMs: 0 };
    if (options?.clientToken) {
      const session = await Promise.race([
        tunnel.fetch('/auth/session', { headers: { Authorization: `Bearer ${options.clientToken}` } }),
        new Promise<null>((resolve) => { globalThis.setTimeout(() => resolve(null), RELAY_PROBE_TIMEOUT_MS); }),
      ]);
      if (!session) return { status: 'unreachable', latencyMs: 0 };
      if (session.status === 401 || session.status === 403) return { status: 'auth', latencyMs: Math.max(0, Date.now() - startedAt) };
      // Older relay hosts may not expose session verification. Preserve their
      // existing health-only behavior while verifying credentials where supported.
      if (!session.ok && session.status !== 404) return { status: 'unreachable', latencyMs: 0 };
      if (session.ok) {
        const body: unknown = await session.json().catch(() => null);
        if (!isRecord(body) || body.authenticated !== true) return { status: 'auth', latencyMs: Math.max(0, Date.now() - startedAt) };
      }
    }
    keep = options?.keepTunnel === true;
    return { status: 'ok', latencyMs: Math.max(0, Date.now() - startedAt), ...(keep ? { tunnel } : {}) };
  } catch {
    return { status: 'unreachable', latencyMs: 0 };
  } finally {
    if (!keep) tunnel.close();
  }
};

const probeDirectE2eeDesktopHost = async (descriptor: DesktopHostDirectE2ee, clientToken?: string | null): Promise<HostProbeResult> => {
  const tunnel = createDirectE2eeTunnelClient(descriptor, clientToken);
  const startedAt = Date.now();
  try {
    const response = await Promise.race([
      tunnel.fetch('/health'),
      new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), RELAY_PROBE_TIMEOUT_MS); }),
    ]);
    const result: HostProbeResult = response?.status === 200
      ? { status: 'ok', latencyMs: Math.max(0, Date.now() - startedAt) }
      : { status: 'unreachable', latencyMs: 0 };
    const failureClassification = tunnel.getStatus().failureClassification;
    return failureClassification ? { ...result, failureClassification } : result;
  } catch {
    const failureClassification = tunnel.getStatus().failureClassification;
    return failureClassification
      ? { status: 'unreachable', latencyMs: 0, failureClassification }
      : { status: 'unreachable', latencyMs: 0 };
  } finally {
    tunnel.close();
  }
};

const blockedDirectStatus = (status: HostProbeResult['status']): boolean =>
  status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';

const failedEncryptedStatus = (status: HostProbeResult['status']): boolean => status !== 'ok' && status !== 'update-recommended';

const terminalEncryptedFailure = (probe: HostProbeResult): boolean =>
  probe.failureClassification === 'crypto'
  || probe.failureClassification === 'protocol'
  || probe.failureClassification === 'terminal';

const unreachableProbe = (): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 });

export const probeDesktopHostTransports = async (
  host: DesktopHost,
  dependencies: DesktopHostProbeDependencies = {
    probeDirect: desktopHostProbe,
    probeDirectE2ee: probeDirectE2eeDesktopHost,
    probeRelay: (descriptor, clientToken) => probeRelayDesktopHost(descriptor, { clientToken, keepTunnel: true }),
  },
): Promise<DesktopHostSelection> => {
  let finalProbe = unreachableProbe();
  const directUrl = normalizeHostUrl(host.apiUrl || host.url);
  const probeDirect = async (): Promise<HostProbeResult> => {
    if (!directUrl) return unreachableProbe();
    return dependencies.probeDirect(directUrl, {
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      expectedServerId: host.relay?.serverId || null,
    }).catch(unreachableProbe);
  };
  const probeRelay = async (): Promise<DesktopHostSelection> => {
    if (!host.relay) return { probe: unreachableProbe(), transport: null };
    const probe: HostProbeResult & { tunnel?: ReturnType<typeof createRelayTunnelClient> } = await dependencies
      .probeRelay(host.relay, host.clientToken || null)
      .catch(unreachableProbe);
    return !failedEncryptedStatus(probe.status)
      ? { probe, transport: { kind: 'relay', descriptor: host.relay, tunnel: probe.tunnel } }
      : { probe, transport: null };
  };

  // A managed direct-E2EE leg has terminal security semantics, so keep explicit
  // candidate order and never let a relay race win before its verdict.
  if (host.directE2ee) {
    if (directUrl) {
      finalProbe = await probeDirect();
      if (!blockedDirectStatus(finalProbe.status)) {
        return { probe: finalProbe, transport: { kind: 'direct', url: directUrl } };
      }
    }
    if (!host.clientToken) {
      finalProbe = { status: 'auth', latencyMs: 1 };
    } else {
      finalProbe = await dependencies.probeDirectE2ee(host.directE2ee, host.clientToken).catch(unreachableProbe);
      if (!failedEncryptedStatus(finalProbe.status)) {
        return { probe: finalProbe, transport: { kind: 'direct-e2ee', descriptor: host.directE2ee } };
      }
      if (terminalEncryptedFailure(finalProbe)) return { probe: finalProbe, transport: null };
    }
    if (!host.relay) return { probe: finalProbe, transport: null };
    return probeRelay();
  }

  if (!directUrl) return probeRelay();
  if (!host.relay) {
    finalProbe = await probeDirect();
    return !blockedDirectStatus(finalProbe.status)
      ? { probe: finalProbe, transport: { kind: 'direct', url: directUrl } }
      : { probe: finalProbe, transport: null };
  }

  // Existing LAN+relay hosts retain direct priority while avoiding a full dead
  // LAN timeout before relay startup. The relay selection carries the live probe
  // tunnel, and the still-running LAN probe is exposed for a late hot-switch.
  const directPromise = probeDirect();
  const headstart = await Promise.race([
    directPromise.then((probe) => ({ probe })),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RELAY_RACE_HEADSTART_MS)),
  ]);
  if (headstart) {
    if (!blockedDirectStatus(headstart.probe.status)) {
      return { probe: headstart.probe, transport: { kind: 'direct', url: directUrl } };
    }
    return probeRelay();
  }

  const relayPromise = probeRelay();
  const first = await Promise.race([
    directPromise.then((probe) => ({ kind: 'direct' as const, probe })),
    relayPromise.then((selection) => ({ kind: 'relay' as const, selection })),
  ]);
  if (first.kind === 'direct') {
    if (!blockedDirectStatus(first.probe.status)) {
      void relayPromise.then((selection) => {
        if (selection.transport?.kind === 'relay') selection.transport.tunnel?.close();
      });
      return { probe: first.probe, transport: { kind: 'direct', url: directUrl } };
    }
    return relayPromise;
  }
  if (first.selection.transport) {
    return { ...first.selection, lateDirect: directPromise, directUrl };
  }
  const lateDirect = await directPromise;
  return !blockedDirectStatus(lateDirect.status)
    ? { probe: lateDirect, transport: { kind: 'direct', url: directUrl } }
    : first.selection;
};

export const desktopHostProbe = async (url: string, options?: { clientToken?: string | null; requestHeaders?: Record<string, string> | null; expectedServerId?: string | null }): Promise<HostProbeResult> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { status: 'unreachable', latencyMs: 0 };
  }

  // `expectedServerId` makes the main-process probe verify the address's
  // UNAUTHENTICATED /health identity before sending the bearer token — required
  // when probing an address learned at runtime rather than typed by the user.
  const raw = await invoke('desktop_host_probe', { url, clientToken: options?.clientToken || undefined, requestHeaders: options?.requestHeaders || undefined, expectedServerId: options?.expectedServerId || undefined });
  if (!isRecord(raw)) {
    return { status: 'unreachable', latencyMs: 0 };
  }

  const rawStatus = raw.status;
  const status: HostProbeResult['status'] =
    rawStatus === 'ok' || rawStatus === 'auth' || rawStatus === 'update-recommended' || rawStatus === 'incompatible' || rawStatus === 'wrong-service' || rawStatus === 'unreachable'
      ? rawStatus
      : 'unreachable';

  const latencyMs = readNumber(raw, 'latencyMs') ?? readNumber(raw, 'latency_ms') ?? 0;
  return { status, latencyMs };
};

export const desktopOpenNewWindowAtUrl = async (url: string, options?: { clientToken?: string | null; requestHeaders?: Record<string, string> | null }): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_new_window_at_url', { url, clientToken: options?.clientToken || undefined, requestHeaders: options?.requestHeaders || undefined });
};

/**
 * Open a saved host in a new window by id. Required for relay-capable hosts —
 * the new window boots the local UI and picks the transport itself (direct
 * first, E2EE tunnel fallback), which a fixed URL cannot express.
 */
export const desktopOpenNewWindowForHost = async (hostId: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_new_window_for_host', { hostId });
};
