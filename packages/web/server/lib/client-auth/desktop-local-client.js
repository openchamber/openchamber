const DESKTOP_LOCAL_CLIENT_KIND = 'desktop-local';
const DESKTOP_LOCAL_DEDUPE_KEY = 'desktop-local';
const DESKTOP_LOCAL_LABEL = 'OpenChamber Desktop';
const MAX_DEVICE_METADATA_LENGTH = 80;

const normalizeDeviceMetadata = (value) => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized ? normalized.slice(0, MAX_DEVICE_METADATA_LENGTH) : undefined;
};

export const createDesktopLocalClientMint = ({ runtimeName, createClient }) => {
  if (runtimeName !== 'desktop') return undefined;
  if (typeof createClient !== 'function') {
    throw new TypeError('Desktop local client mint requires a client auth runtime');
  }

  return (metadata = {}) => {
    const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
    return createClient({
      label: DESKTOP_LOCAL_LABEL,
      clientKind: DESKTOP_LOCAL_CLIENT_KIND,
      dedupeKey: DESKTOP_LOCAL_DEDUPE_KEY,
      authMethod: 'native-electron',
      deviceName: normalizeDeviceMetadata(safeMetadata.deviceName),
      devicePlatform: normalizeDeviceMetadata(safeMetadata.devicePlatform),
      deviceModel: normalizeDeviceMetadata(safeMetadata.deviceModel),
      appVersion: normalizeDeviceMetadata(safeMetadata.appVersion),
    });
  };
};
