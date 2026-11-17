
import { takePendingDesktopHostActions } from '@/lib/desktop';
import { runtimeKeyForDesktopHost } from '@/lib/desktopCurrentHost';
import { desktopHostsGet, desktopHostsSet, getDesktopHostApiUrl, importDesktopHostPairing, normalizeHostUrl } from '@/lib/desktopHosts';
import { restoreDesktopRelayRuntime } from '@/lib/desktopRelayRestore';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';

type HostActionFailure = 'invalid-link' | 'unreachable' | 'failed';

const failureOf = (message: string): HostActionFailure => {
  if (message === 'invalid-connect-link') return 'invalid-link';
  if (message === 'pairing-redeem-failed') return 'unreachable';
  return 'failed';
};

const activateHost = async (hostId: string, options?: { reconnectActive?: boolean }): Promise<void> => {
  const host = (await desktopHostsGet()).hosts.find((entry) => entry.id === hostId);
  if (!host) throw new Error('host-not-found');
  if (host.relay) {
    await restoreDesktopRelayRuntime(host.id, options);
    return;
  }
  const apiBaseUrl = normalizeHostUrl(getDesktopHostApiUrl(host));
  if (!apiBaseUrl) throw new Error('host-not-found');
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken: host.clientToken || null,
    requestHeaders: host.requestHeaders || null,
    runtimeKey: runtimeKeyForDesktopHost(host),
    sshForwarded: host.sshForwarded === true,
  });
};

const pairAndActivate = async (link: string): Promise<void> => {
  const config = await desktopHostsGet();
  const imported = await importDesktopHostPairing(link, config.hosts);
  await desktopHostsSet({
    hosts: imported.hosts,
    defaultHostId: config.defaultHostId || imported.hostId,
    initialHostChoiceCompleted: true,
  });
  await activateHost(imported.hostId, { reconnectActive: true });
};

export const runPendingDesktopHostActions = async (
  onFailure: (failure: HostActionFailure) => void,
): Promise<void> => {
  const actions = await takePendingDesktopHostActions();
  for (const action of actions) {
    try {
      if (action.type === 'pairing') await pairAndActivate(action.link);
      else await activateHost(action.hostId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[desktop] host action failed', action.type, message);
      onFailure(failureOf(message));
    }
  }
};
