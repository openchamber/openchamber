import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const infoSchema = z.object({ version: versionSchema });
const legacyHealthSchema = z.object({ version: versionSchema, healthy: z.boolean() });

const MINIMUM_OPENCODE_VERSION = '2.2.4';

const releaseParts = (version) => version.split(/[-+]/, 1)[0].split('.').map(Number);

const compareRelease = (left, right) => {
  const a = releaseParts(left);
  const b = releaseParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

export const isOpenCodeOlderThan = (version, minimum) => versionSchema.safeParse(version).success
  && compareRelease(version, minimum) < 0;

const isOlderThanMinimum = (version) => isOpenCodeOlderThan(version, MINIMUM_OPENCODE_VERSION);

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
    ...options,
    env: { ...(options.env ?? process.env), ...launch.env },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true,
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

export const describeOpenCodeCompatibility = (version, installation, canInstall, binary = null) => ({
  state: version === null ? 'unavailable' : isSupportedOpenCodeVersion(version) ? 'compatible' : 'incompatible',
  version,
  installation,
  binary,
  minimumVersion: MINIMUM_OPENCODE_VERSION,
  canInstall: version !== null && isOlderThanMinimum(version) && installation === 'managed' && canInstall,
});
