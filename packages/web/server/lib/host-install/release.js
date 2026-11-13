// Finds and downloads the web package of a GitHub release, checked against the
// SHA-256 digest GitHub records for the asset. Runs as root: Node built-ins only.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const GITHUB_API = 'https://api.github.com';
const ASSET_PREFIX = 'openchamber-web-';
const ASSET_SUFFIX = '.tgz';

export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
export const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The web package of the repository's latest release, or of `tag`.
 * Returns `{ version, url, sha256 }`; throws when the release has no web
 * package or GitHub recorded no digest for it.
 */
export async function findRelease({ repo, tag = null, fetchImpl = fetch }) {
  if (!REPO_PATTERN.test(repo ?? '')) throw new ReleaseError('invalid_repo', `Invalid repository "${repo}"`);
  const endpoint = tag ? `releases/tags/${encodeURIComponent(tag)}` : 'releases/latest';
  const response = await fetchImpl(`${GITHUB_API}/repos/${repo}/${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openchamber-host-updater' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new ReleaseError('release_unavailable', `GitHub returned ${response.status} for ${repo} ${tag ?? 'latest release'}`);
  const release = await response.json();
  const releaseVersion = String(release?.tag_name ?? '').replace(/^v/, '');
  for (const asset of Array.isArray(release?.assets) ? release.assets : []) {
    const name = String(asset?.name ?? '');
    if (!name.startsWith(ASSET_PREFIX) || !name.endsWith(ASSET_SUFFIX)) continue;
    const version = name.slice(ASSET_PREFIX.length, -ASSET_SUFFIX.length);
    if (version !== releaseVersion || !VERSION_PATTERN.test(version)) continue;
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
    if (!sha256) throw new ReleaseError('digest_missing', `GitHub has no SHA-256 digest for ${name}`);
    return { version, url: asset.browser_download_url, sha256 };
  }
  throw new ReleaseError('package_missing', `Release ${release?.tag_name ?? '?'} of ${repo} has no ${ASSET_PREFIX}${releaseVersion}${ASSET_SUFFIX}`);
}

const sha256File = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

/** Downloads the package to `destination` and removes it again when its digest does not match. */
export async function downloadRelease({ url, sha256 }, destination, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'openchamber-host-updater' }, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new ReleaseError('download_failed', `Download returned ${response.status}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  if (await sha256File(destination) !== sha256) {
    await fs.rm(destination, { force: true });
    throw new ReleaseError('digest_mismatch', 'The downloaded package does not match the digest GitHub records');
  }
}
