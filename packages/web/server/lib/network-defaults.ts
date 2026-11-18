import net from 'node:net';

export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

export const applyConnectAttemptTimeout = (netModule: Pick<typeof net, 'setDefaultAutoSelectFamilyAttemptTimeout'> = net) => {
  try {
    netModule.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
};
