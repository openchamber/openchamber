/** Wire envelope `v`. Guest postMessage and host pushes use this. */
export const OPENCHAMBER_SDK_CHANNEL = 'openchamber.sdk';
export const OPENCHAMBER_SDK_API_VERSION = 1;
/** Manifest `apiVersion` values this host accepts. Agent and sockets ship on `1`. */
export const OPENCHAMBER_SDK_MANIFEST_API_VERSIONS = [1] as const;
export type OpenChamberManifestApiVersion = (typeof OPENCHAMBER_SDK_MANIFEST_API_VERSIONS)[number];
