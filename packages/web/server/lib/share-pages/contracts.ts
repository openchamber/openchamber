export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ShareStoreOptions {
  fsPromises: typeof import('node:fs/promises');
  path: typeof import('node:path');
  dataDir: string;
  now?: () => number;
}

export interface ShareRelaySettings {
  privateRelay?: { relayUrl?: string } | null;
}
