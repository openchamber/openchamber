import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const infoSchema = z.object({ version: versionSchema });
const legacyHealthSchema = z.object({ version: versionSchema, healthy: z.boolean() });

/**
 * Oldest OpenCode OpenChamber runs against. 2.0.15 added `PATCH /api/session`
 * metadata, which now holds every OpenChamber per-session record.
 */
const MINIMUM_OPENCODE_VERSION = '2.0.15';

const releaseParts = (version) => version.split(/[-+]/, 1)[0].split('.').map(Number);

const compareRelease = (left, right) => {
  const a = releaseParts(left);
  const b = releaseParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const isOlderThanMinimum = (version) => versionSchema.safeParse(version).success
  && compareRelease(version, MINIMUM_OPENCODE_VERSION) < 0;

/** 2.x at or above the minimum. A future major is a contract OpenChamber has not met yet. */
export const isSupportedOpenCodeVersion = (version) => versionSchema.safeParse(version).success
  && releaseParts(version)[0] === 2
  && !isOlderThanMinimum(version);

export const readOpenCodeInfo = async (response) => {
  if (!response.ok) return null;
  const parsed = infoSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
};

export const readOpenCodeCliVersion = async (launch, options = {}) => {
  const { stdout } = await execute(launch.binary, [...launch.args, '--version'], {
    ...options, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true,
  });
  const match = /^(?:opencode\s+v?)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(stdout.trim());
  if (!match) throw new Error('Could not determine the installed OpenCode version.');
  return match[1];
};

export class UnsupportedOpenCodeVersionError extends Error {
  constructor(version) {
    super(`OpenCode ${version} is installed. OpenChamber requires OpenCode ${MINIMUM_OPENCODE_VERSION} or newer.`);
    this.name = 'UnsupportedOpenCodeVersionError';
    this.version = version;
  }
}

export const requireOpenCodeV2 = async (launch, options) => {
  const version = await readOpenCodeCliVersion(launch, options);
  if (!isSupportedOpenCodeVersion(version)) throw new UnsupportedOpenCodeVersionError(version);
  return version;
};

// External URLs have no local executable. A legacy probe identifies v1 only
// from its JSON contract; neither HTML fallbacks nor auth failures imply v1.
// v1 has no `/api/info`: its catch-all serves the web UI, and a v1 build
// without the embedded UI proxies that path to app.opencode.ai, which can hang
// or fail. A failed v2 probe therefore still falls through to the v1 probe.
export const readExternalOpenCodeVersion = async (baseUrl, headers, fetchImpl = fetch) => {
  const request = (pathname) => fetchImpl(new URL(pathname, baseUrl), {
    headers: { ...headers, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  const response = await request('/api/info').catch(() => null);
  if (response && (response.status === 401 || response.status === 403)) return null;
  const info = response ? await readOpenCodeInfo(response) : null;
  if (info) return info.version;
  const legacy = await request('/global/health');
  if (!legacy.ok) return null;
  const parsed = legacyHealthSchema.safeParse(await legacy.json().catch(() => null));
  return parsed.success && parsed.data.version.startsWith('1.') ? parsed.data.version : null;
};

export const describeOpenCodeCompatibility = (version, installation, canInstall) => ({
  state: version === null ? 'unavailable' : isSupportedOpenCodeVersion(version) ? 'compatible' : 'incompatible',
  version,
  installation,
  minimumVersion: MINIMUM_OPENCODE_VERSION,
  // The installer fetches the latest release, which clears both a 1.x CLI and
  // a 2.x one older than the minimum.
  canInstall: version !== null && isOlderThanMinimum(version) && installation === 'managed' && canInstall,
});
