import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

const originOf = (raw) => {
  try { return new URL(raw).origin; } catch { return ''; }
};

export const isRuntimeBootstrapSenderAllowed = (senderUrl, { localOrigin, sidecarUrl } = {}) => {
  try {
    const parsed = new URL(senderUrl);
    if (parsed.protocol === 'openchamber-ui:' && parsed.hostname === 'app') return true;
  } catch {
    return false;
  }
  const senderOrigin = originOf(senderUrl);
  if (!senderOrigin || senderOrigin === 'null') return false;
  return [localOrigin, sidecarUrl].some((allowed) => allowed && originOf(allowed) === senderOrigin);
};

export const sanitizeRuntimeBootstrapConfig = (config) => ({
  apiBaseUrl: typeof config?.apiBaseUrl === 'string' ? config.apiBaseUrl : '',
  clientToken: typeof config?.clientToken === 'string' ? config.clientToken : '',
  requestHeaders: sanitizeRuntimeRequestHeaders(config?.requestHeaders || {}),
  relayHostId: typeof config?.relayHostId === 'string' ? config.relayHostId : '',
});

export const resolveRuntimeBootstrap = (senderUrl, windowConfig, allowed) => (
  isRuntimeBootstrapSenderAllowed(senderUrl, allowed)
    ? sanitizeRuntimeBootstrapConfig(windowConfig)
    : null
);

export const buildDesktopAdditionalArguments = ({
  localOrigin = '', homeDirectory = '', macosMajor = 0, macVibrancy, bootOutcome,
} = {}) => [
  `--openchamber-local-origin=${localOrigin}`,
  `--openchamber-home=${homeDirectory}`,
  `--openchamber-macos-major=${macosMajor}`,
  ...(typeof macVibrancy === 'boolean' ? [`--openchamber-mac-vibrancy=${macVibrancy ? '1' : '0'}`] : []),
  ...(bootOutcome !== undefined ? [`--openchamber-boot-outcome=${JSON.stringify(bootOutcome)}`] : []),
];
