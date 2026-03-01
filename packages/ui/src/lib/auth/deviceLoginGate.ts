export type LocalSidecarStatus = 'unknown' | 'running' | 'not-running';

type InstanceCandidate = {
  id: string;
  lastUsedAt: number | null;
};

export const isLikelyLocalHostname = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]') {
    return true;
  }
  if (host.endsWith('.local')) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }
  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (octets[0] === 127 || octets[0] === 10) {
    return true;
  }
  if (octets[0] === 192 && octets[1] === 168) {
    return true;
  }
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return true;
  }
  if (octets[0] === 169 && octets[1] === 254) {
    return true;
  }
  return false;
};

export const isLocalOpenChamberHealthPayload = (payload: unknown): boolean => {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const candidate = payload as { status?: unknown; openCodeRunning?: unknown; openCodePort?: unknown };
  if (candidate.status === 'ok') {
    return true;
  }
  if (candidate.openCodeRunning === true) {
    return true;
  }
  if (typeof candidate.openCodePort === 'number' && Number.isFinite(candidate.openCodePort)) {
    return true;
  }
  return false;
};

export const shouldForceDeviceLogin = (input: {
  hydrated: boolean;
  instancesCount: number;
  hasDesktopSidecar: boolean;
  localSidecarStatus: LocalSidecarStatus;
}): boolean => {
  return input.hydrated
    && input.instancesCount === 0
    && !input.hasDesktopSidecar
    && input.localSidecarStatus === 'not-running';
};

export const shouldBypassDeviceLoginForVerification = (search: string): boolean => {
  const params = new URLSearchParams(search);
  if ((params.get('devices') || '').trim() === '1') {
    return true;
  }
  if ((params.get('user_code') || '').trim().length > 0) {
    return true;
  }
  return false;
};

export const getAuthenticatedInstanceIdsByRecency = (
  instances: InstanceCandidate[],
  hasAccessToken: (instanceId: string) => boolean,
): string[] => {
  return [...instances]
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .filter((instance) => hasAccessToken(instance.id))
    .map((instance) => instance.id);
};

export const shouldForceMobileDeviceLogin = (input: {
  isMobileRuntime: boolean;
  hydrated: boolean;
  hasDesktopSidecar: boolean;
  authenticatedInstancesCount: number;
}): boolean => {
  return input.isMobileRuntime
    && input.hydrated
    && !input.hasDesktopSidecar
    && input.authenticatedInstancesCount === 0;
};
