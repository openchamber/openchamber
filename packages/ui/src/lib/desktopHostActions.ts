// Host work the desktop shell hands to the main window: redeeming a pairing
// link the user confirmed in the shell's prompt, and activating a host that
// has a relay leg. Both need the E2EE relay client, which lives here. Pairing
// goes through the same importDesktopHostPairing as Import Link in Settings, so
// a link whose only reachable leg is the relay pairs over the tunnel and the
// saved host keeps both its direct and relay legs. Activation probes the direct
// address first and falls back to the tunnel, like the host switcher.

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
  });
};

const pairAndActivate = async (link: string): Promise<void> => {
  const config = await desktopHostsGet();
  const imported = await importDesktopHostPairing(link, config.hosts);
  await desktopHostsSet({
    hosts: imported.hosts,
    // Pairing adds an instance; it becomes the default only when none is set.
    defaultHostId: config.defaultHostId || imported.hostId,
    initialHostChoiceCompleted: true,
  });
  await activateHost(imported.hostId, { reconnectActive: true });
};

/** Runs every pending action in order; one failure does not stop the rest. */
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
