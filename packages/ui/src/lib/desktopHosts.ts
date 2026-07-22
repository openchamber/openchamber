import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { parsePairingConnectionPayload, type PairingEndpointCandidate } from '@/lib/connectionPayload';

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

const desktopPlatformName = (): string | undefined => {
  if (typeof navigator === 'undefined') return undefined;
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return undefined;
};

export const importDesktopHostPairing = async (
  link: string,
  hosts: DesktopHost[],
): Promise<{ hosts: DesktopHost[]; hostId: string }> => {
  const payload = parsePairingConnectionPayload(link);
  if (!payload) throw new Error('invalid-connect-link');

  const installId = await desktopInstallIdGet().catch(() => '');
  const redeemInit: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      pairingId: payload.pairingId,
      secret: payload.secret,
      clientLabel: payload.label || 'OpenChamber Desktop',
      clientKind: 'desktop',
      deviceName: 'OpenChamber Desktop',
      devicePlatform: desktopPlatformName(),
      ...(installId ? { dedupeKey: `desktop:${installId}` } : {}),
    }),
  };
  const readToken = async (response: Response): Promise<string | null> => {
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { clientToken?: unknown } | null;
    const token = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
    return token || null;
  };

  let redeemed: { directUrl?: string; relay?: DesktopHostRelay; token: string } | null = null;
  const candidates = [...payload.candidates].sort(
    (a, b) => (a.type === 'relay' ? 1 : 0) - (b.type === 'relay' ? 1 : 0),
  );
  for (const candidate of candidates) {
    if (candidate.type === 'relay') {
      const tunnel = createRelayTunnelClient({
        relayUrl: candidate.relayUrl,
        serverId: candidate.serverId,
        hostEncPubJwk: candidate.hostEncPubJwk,
        ...(candidate.grant ? { grant: candidate.grant } : {}),
      });
      try {
        const token = await readToken(await tunnel.fetch('/api/client-auth/pairing/redeem', redeemInit));
        if (token) {
          redeemed = {
            relay: { relayUrl: candidate.relayUrl, serverId: candidate.serverId, hostEncPubJwk: candidate.hostEncPubJwk },
            token,
          };
          break;
        }
      } catch {
        // Try the next advertised transport.
      } finally {
        tunnel.close();
      }
      continue;
    }
    const directUrl = normalizeHostUrl(candidate.url);
    if (!directUrl) continue;
    try {
      const token = await readToken(await fetch(`${directUrl}/api/client-auth/pairing/redeem`, redeemInit));
      if (token) {
        redeemed = { directUrl, token };
        break;
      }
    } catch {
      // Try the next advertised transport.
    }
  }
  if (!redeemed) throw new Error('pairing-redeem-failed');

  const relayCandidate = payload.candidates.find(
    (candidate): candidate is Extract<PairingEndpointCandidate, { type: 'relay' }> => candidate.type === 'relay',
  );
  const relay = redeemed.relay || (relayCandidate
    ? { relayUrl: relayCandidate.relayUrl, serverId: relayCandidate.serverId, hostEncPubJwk: relayCandidate.hostEncPubJwk }
    : undefined);
  const firstDirectUrl = payload.candidates
    .filter((candidate): candidate is Extract<PairingEndpointCandidate, { type: 'lan' | 'tunnel' }> => candidate.type !== 'relay')
    .map((candidate) => normalizeHostUrl(candidate.url))
    .find((value): value is string => Boolean(value));
  const directUrl = redeemed.directUrl || firstDirectUrl;
  const url = directUrl || (relay ? relayHostDisplayUrl(relay.serverId) : null);
  if (!url) throw new Error('pairing-missing-transport');

  const existing = hosts.find((host) => (
    relay ? host.relay?.serverId === relay.serverId : (!host.relay && normalizeHostUrl(host.apiUrl || host.url) === url)
  ));
  const hostId = existing?.id || (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const nextHost: DesktopHost = {
    ...(existing || {}),
    id: hostId,
    label: payload.label || existing?.label || redactSensitiveUrl(url),
    url,
    apiUrl: directUrl,
    clientToken: redeemed.token,
    ...(relay ? { relay } : {}),
  };
  return {
    hostId,
    hosts: existing
      ? hosts.map((host) => host.id === hostId ? nextHost : host)
      : [nextHost, ...hosts],
  };
};

export type HostProbeResult = {
  status: 'ok' | 'auth' | 'update-recommended' | 'incompatible' | 'wrong-service' | 'unreachable';
  latencyMs: number;
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
  if (!id || !label || !url) return null;
  return {
    id,
    label,
    url,
    ...(apiUrl ? { apiUrl } : {}),
    ...(clientToken ? { clientToken } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
    ...(relay ? { relay } : {}),
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
  options?: { keepTunnel?: boolean },
): Promise<HostProbeResult & { tunnel?: ReturnType<typeof createRelayTunnelClient> }> => {
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
    keep = options?.keepTunnel === true;
    return { status: 'ok', latencyMs: Math.max(0, Date.now() - startedAt), ...(keep ? { tunnel } : {}) };
  } catch {
    return { status: 'unreachable', latencyMs: 0 };
  } finally {
    if (!keep) tunnel.close();
  }
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
