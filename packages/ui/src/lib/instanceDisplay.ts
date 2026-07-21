import { getDesktopHostApiUrl, locationMatchesHost, type DesktopHost } from '@/lib/desktopHosts';
import { isLoopbackHttpUrl } from '@/lib/url';

export type DesktopInstanceDisplay =
  | { kind: 'local' }
  | { kind: 'host'; label: string }
  | { kind: 'generic' };

export type DesktopInstanceDisplayInput = {
  isPackagedElectronPage: boolean;
  runtimeKey: string;
  runtimeApiBaseUrl: string;
  localOrigin: string;
  hosts: DesktopHost[];
};

export const resolveDesktopInstanceDisplay = ({
  isPackagedElectronPage,
  runtimeKey,
  runtimeApiBaseUrl,
  localOrigin,
  hosts,
}: DesktopInstanceDisplayInput): DesktopInstanceDisplay => {
  const normalizedRuntimeKey = runtimeKey.trim();
  if (normalizedRuntimeKey.startsWith('host:')) {
    const hostId = normalizedRuntimeKey.slice('host:'.length);
    const host = hosts.find((candidate) => candidate.id === hostId);
    return host?.label.trim()
      ? { kind: 'host', label: host.label.trim() }
      : { kind: 'generic' };
  }

  const configuredHost = hosts.find((host) => (
    runtimeApiBaseUrl
      ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host))
      : false
  ));
  if (configuredHost) {
    return configuredHost.label.trim()
      ? { kind: 'host', label: configuredHost.label.trim() }
      : { kind: 'generic' };
  }

  const canResolveAsLocal = (
    normalizedRuntimeKey === 'local'
    || !normalizedRuntimeKey
    || normalizedRuntimeKey.startsWith('url:')
  );
  if (!canResolveAsLocal) {
    return { kind: 'generic' };
  }

  if (normalizedRuntimeKey === 'local') {
    return { kind: 'local' };
  }

  if (runtimeApiBaseUrl && localOrigin && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
    return { kind: 'local' };
  }

  if (isPackagedElectronPage && isLoopbackHttpUrl(runtimeApiBaseUrl)) {
    return { kind: 'local' };
  }

  return { kind: 'generic' };
};
