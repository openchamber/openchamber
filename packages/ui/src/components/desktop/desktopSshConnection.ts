import { desktopHostsGet, type DesktopHost } from '@/lib/desktopHosts';
import { desktopSshConnect, desktopSshStatus, type DesktopSshInstanceStatus } from '@/lib/desktopSsh';

export const SSH_CONNECT_TIMEOUT_MS = 90_000;
export const SSH_CONNECT_CANCELLED_ERROR = 'SSH connection cancelled';

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export const waitForSshReady = async (
  id: string,
  timeoutMs: number,
  onUpdate: (status: DesktopSshInstanceStatus) => void,
  shouldCancel?: () => boolean,
): Promise<DesktopSshInstanceStatus> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) {
      throw new Error(SSH_CONNECT_CANCELLED_ERROR);
    }

    const statuses = await desktopSshStatus(id).catch(() => []);
    const status = statuses.find((item) => item.id === id);
    if (status) {
      onUpdate(status);
      if (status.phase === 'ready') {
        return status;
      }
      if (status.phase === 'error') {
        throw new Error(status.detail || 'SSH connection failed');
      }
    }
    await sleep(700);
  }

  if (shouldCancel?.()) {
    throw new Error(SSH_CONNECT_CANCELLED_ERROR);
  }

  throw new Error('Timed out waiting for SSH connection');
};

export const connectDesktopSshHost = async (
  host: DesktopHost,
  options: { ready: boolean; onStatus: (status: DesktopSshInstanceStatus) => void },
): Promise<DesktopHost> => {
  if (!options.ready) {
    await desktopSshConnect(host.id);
    await waitForSshReady(host.id, SSH_CONNECT_TIMEOUT_MS, options.onStatus);
  }
  const refreshed = (await desktopHostsGet()).hosts.find((entry) => entry.id === host.id);
  if (!refreshed) throw new Error('SSH host is no longer available');
  return refreshed;
};
