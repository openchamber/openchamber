import { isRuntimeBootstrapSenderAllowed } from './runtime-bootstrap.mjs';
import { sanitizeHostDirectE2eeForStorage, sanitizeHostRelayForStorage } from './host-storage-sanitizer.mjs';

const sanitizePublicUrl = (value, protocols) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (!protocols.has(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const normalized = url.toString();
    return url.pathname === '/' ? normalized.replace(/\/$/, '') : normalized;
  } catch {
    return null;
  }
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SYNTHETIC_LABEL = /^(?:relay|direct-e2ee):\/\/[a-zA-Z0-9._-]+$/;
const SYNTHETIC_LABEL_PREFIX = /^(?:relay|direct-e2ee):/i;
const URL_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const sanitizePublicLabel = (value, fallback) => {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return fallback;
  const label = value.trim();
  if (!label) return fallback;
  if (SYNTHETIC_LABEL.test(label)) return label;
  if (SYNTHETIC_LABEL_PREFIX.test(label)) return fallback;

  if (label.startsWith('//')) {
    try {
      const url = new URL(label, 'https://public-label.invalid');
      return url.host ? `//${url.host}` : fallback;
    } catch {
      return fallback;
    }
  }

  if (!URL_SCHEME_PREFIX.test(label)) return label;
  try {
    const url = new URL(label);
    return url.host ? `${url.protocol}//${url.host}` : fallback;
  } catch {
    return fallback;
  }
};

const redactHost = (host) => {
  if (!host || typeof host !== 'object' || Array.isArray(host)) return null;
  const id = typeof host.id === 'string' ? host.id.trim() : '';
  const label = sanitizePublicLabel(host.label, id);
  if (!id || !label) return null;
  const url = sanitizePublicUrl(host.url, new Set(['http:', 'https:'])) || (typeof host.url === 'string' && /^(?:relay|direct-e2ee):\/\/[a-zA-Z0-9._-]+$/.test(host.url) ? host.url : null);
  const apiUrl = sanitizePublicUrl(host.apiUrl, new Set(['http:', 'https:']));
  const relay = sanitizeHostRelayForStorage(host.relay);
  const directE2ee = sanitizeHostDirectE2eeForStorage(host.directE2ee);
  if (!url && !apiUrl && !relay && !directE2ee) return null;
  const publicRelay = relay ? {
    ...relay,
    relayUrl: sanitizePublicUrl(relay.relayUrl, new Set(['ws:', 'wss:'])),
  } : null;
  return {
    id,
    label,
    ...(url ? { url } : {}),
    ...(apiUrl ? { apiUrl } : {}),
    ...(publicRelay?.relayUrl ? { relay: publicRelay } : {}),
    ...(directE2ee ? { directE2ee } : {}),
  };
};

export const redactDesktopHostsConfig = (config) => {
  const hosts = Array.isArray(config?.hosts) ? config.hosts.map(redactHost).filter(Boolean) : [];
  const defaultHostId = typeof config?.defaultHostId === 'string' ? config.defaultHostId.trim() : '';
  return {
    hosts,
    defaultHostId: defaultHostId && hosts.some((host) => host.id === defaultHostId) ? defaultHostId : null,
    initialHostChoiceCompleted: config?.initialHostChoiceCompleted === true,
    localOrigin: sanitizePublicUrl(config?.localOrigin, new Set(['http:', 'https:'])),
  };
};

export const resolveDesktopHostsForSender = (senderUrl, fullConfig, allowed) => (
  isRuntimeBootstrapSenderAllowed(senderUrl, allowed) ? fullConfig : redactDesktopHostsConfig(fullConfig)
);
