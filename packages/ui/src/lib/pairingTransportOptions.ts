export type AddDeviceTransportType = 'local' | 'lan' | 'relay' | 'managed-e2ee';

export interface PairingTransportRequest {
  serverUrl?: string;
  includeRelay: boolean;
  includeDirect: boolean;
  includeDirectE2ee: boolean;
}

export function resolvePairingTransportRequest(
  transport: AddDeviceTransportType,
  options: {
    localUrl?: string | null;
    lanUrl?: string | null;
    addDeviceFallback?: boolean;
    relayAvailable?: boolean;
  }
): PairingTransportRequest {
  let serverUrl: string | undefined;
  let includeRelay = true;
  let includeDirect = true;
  let includeDirectE2ee = false;

  if (transport === 'managed-e2ee') {
    serverUrl = undefined;
    includeDirect = false;
    includeDirectE2ee = true;
    includeRelay = false;
  } else if (transport === 'local') {
    serverUrl = options.localUrl ?? undefined;
    includeRelay = false;
  } else if (transport === 'lan') {
    serverUrl = options.lanUrl ?? undefined;
    includeRelay = !!options.addDeviceFallback;
  } else if (options.addDeviceFallback && options.lanUrl) {
    serverUrl = options.lanUrl;
    includeRelay = true;
  } else {
    includeDirect = false;
    includeRelay = true;
  }

  return { serverUrl, includeRelay, includeDirect, includeDirectE2ee };
}

export function selectPairingTransport(
  preferred: AddDeviceTransportType | null | undefined,
  options: {
    directE2eeAvailable: boolean;
    relayAvailable: boolean;
    lanUrl?: string | null;
    localUrl?: string | null;
  }
): AddDeviceTransportType {
  if (preferred === 'managed-e2ee') {
    if (options.directE2eeAvailable) {
      return 'managed-e2ee';
    }
    if (options.lanUrl) {
      return 'lan';
    }
    return 'local';
  }
  if (options.relayAvailable) {
    return 'relay';
  }
  if (options.lanUrl) {
    return 'lan';
  }
  return 'local';
}

const ADD_DEVICE_INTENT_TTL_MS = 30_000;
type AddDeviceIntentRecord = { intent: 'managed-e2ee'; expiresAt: number };
let pendingIntent: AddDeviceIntentRecord | null = null;

export function setAddDeviceIntent(intent: 'managed-e2ee' | null, now: () => number = Date.now): void {
  pendingIntent = intent ? { intent, expiresAt: now() + ADD_DEVICE_INTENT_TTL_MS } : null;
}

export function consumeAddDeviceIntent(now: () => number = Date.now): 'managed-e2ee' | null {
  const record = pendingIntent;
  pendingIntent = null;
  return record && now() < record.expiresAt ? record.intent : null;
}
