import * as net from 'node:net';

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
