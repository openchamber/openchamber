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
  homeDirectory: typeof config?.homeDirectory === 'string' ? config.homeDirectory : '',
});

export const resolveRuntimeBootstrap = (senderUrl, windowConfig, allowed) => (
  isRuntimeBootstrapSenderAllowed(senderUrl, allowed)
    ? sanitizeRuntimeBootstrapConfig(windowConfig)
    : null
);

export const buildDesktopAdditionalArguments = ({
  localOrigin = '', macosMajor = 0, macVibrancy, bootOutcome,
} = {}) => [
  `--openchamber-local-origin=${localOrigin}`,
  `--openchamber-macos-major=${macosMajor}`,
  ...(typeof macVibrancy === 'boolean' ? [`--openchamber-mac-vibrancy=${macVibrancy ? '1' : '0'}`] : []),
  ...(bootOutcome !== undefined ? [`--openchamber-boot-outcome=${JSON.stringify(bootOutcome)}`] : []),
];

export const buildRuntimeBootMetadataScript = ({ macosMajor = 0, bootOutcome } = {}) => {
  const macVersion = Number.isFinite(Number(macosMajor)) ? Number(macosMajor) : 0;
  const outcome = JSON.stringify(bootOutcome ?? null);
  return `(function(){try{window.__OPENCHAMBER_MACOS_MAJOR__=${macVersion};var __oc_bo=${outcome};if(__oc_bo){window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__=__oc_bo;}}catch(_e){}}())`;
};
