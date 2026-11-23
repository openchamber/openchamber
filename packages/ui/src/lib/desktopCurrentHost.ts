import {
  getDesktopHostApiUrl,
  locationMatchesHost,
  normalizeHostUrl,
  redactSensitiveUrl,
  type DesktopHost,
} from '@/lib/desktopHosts';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';


export const LOCAL_HOST_ID = 'local';

export const getLocalDesktopOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.__OPENCHAMBER_LOCAL_ORIGIN__?.trim() || '';
};

export const withLocalDesktopHost = (hosts: DesktopHost[], localOrigin: string | null | undefined): DesktopHost[] => (
  localOrigin ? [{ id: LOCAL_HOST_ID, label: 'Local', url: localOrigin }, ...hosts] : hosts
);

export const runtimeKeyForDesktopHost = (host: DesktopHost): string => {
  if (host.id === LOCAL_HOST_ID) return 'local';
  return `host:${host.id}`;
};

type ResolvedDesktopHost = {
  id: string;
  label: string;
  url: string;
};

export const resolveCurrentDesktopHost = (hosts: DesktopHost[]): ResolvedDesktopHost => {
  const currentHref = typeof window === 'undefined' ? '' : window.location.href;
  const localOrigin = hosts.find((host) => host.id === LOCAL_HOST_ID)?.url || getLocalDesktopOrigin();
  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const normalizedLocal = normalizeHostUrl(localOrigin) || localOrigin;
  const normalizedCurrent = normalizeHostUrl(currentHref) || currentHref;

  const activeRuntimeKey = getRuntimeKey();
  const relayMatch = hosts.find((host) => host.relay && runtimeKeyForDesktopHost(host) === activeRuntimeKey);
  if (relayMatch) {
    return { id: relayMatch.id, label: relayMatch.label, url: relayMatch.url };
  }

  if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const runtimeMatch = hosts.find((host) => (
    runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false
  ));

  if (runtimeMatch) {
    return {
      id: runtimeMatch.id,
      label: runtimeMatch.label,
      url: normalizeHostUrl(getDesktopHostApiUrl(runtimeMatch)) || getDesktopHostApiUrl(runtimeMatch),
    };
  }

  if (currentHref && locationMatchesHost(currentHref, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const match = hosts.find((host) => (currentHref ? locationMatchesHost(currentHref, host.url) : false));

  if (match) {
    return { id: match.id, label: match.label, url: normalizeHostUrl(match.url) || match.url };
  }

  const packagedPage = currentHref.startsWith('openchamber-ui://');
  if (packagedPage && localOrigin && !runtimeApiBaseUrl) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const address = runtimeApiBaseUrl
    ? normalizeHostUrl(runtimeApiBaseUrl) || runtimeApiBaseUrl
    : packagedPage ? '' : normalizedCurrent;
  return {
    id: 'custom',
    label: redactSensitiveUrl(address || 'Instance'),
    url: address,
  };
};
