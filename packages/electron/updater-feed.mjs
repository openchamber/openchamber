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

// Both channels are mirrored to Cloudflare R2 (scripts/release-mirror):
// release.yml copies each Stable release, canary.yml each night. The same
// files and manifests as on GitHub, served by Cloudflare, which stays up when
// GitHub's release downloads fail and downloads faster. GitHub stays the
// fallback.
export const STABLE_MIRROR_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://downloads.openchamber.dev/desktop/stable/',
});

export const CANARY_MIRROR_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://downloads.openchamber.dev/desktop/canary/',
});

// After the mirror fails a check or a download, the app reads GitHub for this
// long before trying the mirror again, so a broken mirror costs one failed
// request, not one per check.
export const MIRROR_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/** The source a check reads: the mirror unless it failed within the backoff, GitHub otherwise. */
export const pickUpdaterSource = ({ mirrorFailedAt = null, now = Date.now() } = {}) => (
  mirrorFailedAt === null || now - mirrorFailedAt >= MIRROR_FAILURE_BACKOFF_MS ? 'mirror' : 'github'
);

// Where the app takes its updates from: the releases, or the nightly Canary
// build. The person picks it in Settings → About; the app installs the next
// update from that channel and keeps following it. Without a pick (unset, an
// older build's value) the app follows its own build, so a Canary build
// installed from the canary pre-release does not offer the older release as
// an update nobody asked for.
export const isUpdateChannel = (value) => value === 'stable' || value === 'canary';

// A Canary build's version is the release it leads to with a `canary`
// pre-release part: 2.5.4-canary.20261030.123.
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
