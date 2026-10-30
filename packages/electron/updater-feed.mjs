import fs from 'node:fs';

export const PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: 'github',
  owner: 'openchamber',
  repo: 'openchamber',
});

// Canary builds replace the files of one pre-release, tagged `canary`, every
// night. The GitHub provider reads only the latest full release, so the
// Canary channel reads that pre-release's files directly, and the Stable
// channel never sees them.
export const CANARY_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://github.com/openchamber/openchamber/releases/download/canary/',
});

// Where the app takes its updates from: the releases, or the nightly Canary
// build. The person picks it in Settings → About; the app installs the next
// update from that channel and keeps following it. Anything else stored
// (unset, an older build's value) is Stable.
export const isUpdateChannel = (value) => value === 'stable' || value === 'canary';
export const normalizeUpdateChannel = (value) => (value === 'canary' ? 'canary' : 'stable');

// A Canary build's version is the release it leads to with a `canary`
// pre-release part: 2.5.4-canary.20261030.123.
export const isCanaryVersion = (version) => /-canary\./.test(String(version ?? ''));

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
} = {}) => {
  const productionFeed = channel === 'canary' ? CANARY_UPDATER_FEED : PRODUCTION_UPDATER_FEED;
  if (environment.OPENCHAMBER_E2E !== '1'
    || testBuild !== true) {
    return productionFeed;
  }

  const url = parseLoopbackUpdaterUrl(environment.OPENCHAMBER_UPDATER_E2E_URL);
  if (!url) return productionFeed;
  return { provider: 'generic', url };
};
