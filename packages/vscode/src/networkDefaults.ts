import * as net from 'node:net';

// Mirrors the web runtime policy for distant quota endpoints. The extension
// host has its own Node fetch stack and does not inherit server defaults.
export function applyConnectAttemptTimeout(
  netModule: Partial<Pick<typeof net, 'setDefaultAutoSelectFamilyAttemptTimeout'>> = net,
): boolean {
  try {
    if (!netModule.setDefaultAutoSelectFamilyAttemptTimeout) return false;
    netModule.setDefaultAutoSelectFamilyAttemptTimeout(5_000);
    return true;
  } catch {
    return false;
  }
}
