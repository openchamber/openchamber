import net from 'node:net';

// external: #3399 Node's 250 ms address-family attempt timeout rejects distant providers; raising it preserves IPv6-to-IPv4 fallback.
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

export const applyConnectAttemptTimeout = (netModule = net) => {
  try {
    netModule.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
};
