import { isTauriShell } from '@/lib/desktop';

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

type TauriGlobal = {
  core?: {
    invoke?: TauriInvoke;
  };
};

export type DesktopHost = {
  id: string;
  label: string;
  url: string;
};

export type DesktopHostsConfig = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
};

export type HostProbeResult = {
  status: 'ok' | 'auth' | 'unreachable';
  latencyMs: number;
};

const SENSITIVE_QUERY_KEY = /token|auth|secret|api/i;

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

export const redactSensitiveUrl = (raw: string): string => {
  const normalized = normalizeHostUrl(raw);
  if (!normalized) {
    return raw;
  }

  try {
    const url = new URL(normalized);
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
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
  if (!id || !label || !url) return null;
  return { id, label, url };
};

const getInvoke = (): TauriInvoke | null => {
  if (!isTauriShell()) return null;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function' ? tauri.core.invoke : null;
};

export const desktopHostsGet = async (): Promise<DesktopHostsConfig> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { hosts: [], defaultHostId: 'local' };
  }

  const raw = await invoke('desktop_hosts_get');
  if (!isRecord(raw)) {
    return { hosts: [], defaultHostId: null };
  }

  const hostsRaw = raw.hosts;
  const hosts = Array.isArray(hostsRaw)
    ? hostsRaw.map(parseHost).filter((h): h is DesktopHost => Boolean(h))
    : [];

  const defaultHostId =
    readString(raw, 'defaultHostId') ||
    readString(raw, 'default_host_id') ||
    readString(raw, 'defaultHostID');

  return { hosts, defaultHostId };
};

export const desktopHostsSet = async (config: DesktopHostsConfig): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_hosts_set', {
    config: {
      hosts: config.hosts,
      defaultHostId: config.defaultHostId,
    },
  });
};

export const desktopHostProbe = async (url: string): Promise<HostProbeResult> => {
  const invoke = getInvoke();
  if (!invoke) {
    return { status: 'unreachable', latencyMs: 0 };
  }

  const raw = await invoke('desktop_host_probe', { url });
  if (!isRecord(raw)) {
    return { status: 'unreachable', latencyMs: 0 };
  }

  const rawStatus = raw.status;
  const status: HostProbeResult['status'] =
    rawStatus === 'ok' || rawStatus === 'auth' || rawStatus === 'unreachable'
      ? rawStatus
      : 'unreachable';

  const latencyMs = readNumber(raw, 'latencyMs') ?? readNumber(raw, 'latency_ms') ?? 0;
  return { status, latencyMs };
};

export const desktopOpenNewWindowAtUrl = async (url: string): Promise<void> => {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('desktop_new_window_at_url', { url });
};
