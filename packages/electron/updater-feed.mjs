import fs from 'node:fs';

export const PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: 'github',
  owner: 'openchamber',
  repo: 'openchamber',
});

export const CANARY_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://github.com/openchamber/openchamber/releases/download/canary/',
});

export const STABLE_MIRROR_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://downloads.openchamber.dev/desktop/stable/',
});

export const CANARY_MIRROR_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://downloads.openchamber.dev/desktop/canary/',
});

export const MIRROR_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

export const pickUpdaterSource = ({ mirrorFailedAt = null, now = Date.now() } = {}) => (
  mirrorFailedAt === null || now - mirrorFailedAt >= MIRROR_FAILURE_BACKOFF_MS ? 'mirror' : 'github'
);

export const isUpdateChannel = (value) => value === 'stable' || value === 'canary';

export const isCanaryVersion = (version) => /-canary\./.test(String(version ?? ''));

export const normalizeUpdateChannel = (value, appVersion) => {
  if (isUpdateChannel(value)) return value;
  return isCanaryVersion(appVersion) ? 'canary' : 'stable';
};

const isLoopbackHostname = (hostname) => {
  if (hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const values = octets.map(Number);
  return values[0] === 127 && values.every((value) => value <= 255);
};

export const parseLoopbackUpdaterUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || !isLoopbackHostname(url.hostname)
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const resolveUpdaterFeed = ({
  environment = process.env,
  testBuild = false,
  channel = 'stable',
  source = 'github',
} = {}) => {
  const productionFeed = channel === 'canary'
    ? (source === 'mirror' ? CANARY_MIRROR_UPDATER_FEED : CANARY_UPDATER_FEED)
    : (source === 'mirror' ? STABLE_MIRROR_UPDATER_FEED : PRODUCTION_UPDATER_FEED);
  if (environment.OPENCHAMBER_E2E !== '1'
    || testBuild !== true) {
    return productionFeed;
  }

  const url = parseLoopbackUpdaterUrl(environment.OPENCHAMBER_UPDATER_E2E_URL);
  if (!url) return productionFeed;
  return { provider: 'generic', url };
};
