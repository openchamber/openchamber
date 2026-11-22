import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { getWebPackagePaths } from './web-package-paths.js';
import { compareVersions as compareVersionOrder } from './version-order.js';
import { readBoundedResponseText } from './shared/response-body.js';
import { isEnterpriseMode } from './enterprise-mode.js';
import { getSpawnSyncBaseOptions, spawnPackageManagerProbe } from './package-manager-probe.js';

import { resolveNpmRegistryRequest } from './npm/npm-registry-config.js';
import type { JsonObject, JsonValue } from './shared/json-values.js';
import { isFunction, isString } from './shared/object-guards.js';

type VersionValue = JsonValue | undefined;
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
type DetectionReason = 'forced-env' | 'install-path-owner' | 'global-root-owner' | 'hinted-visible-install' | 'runtime-visible-install' | 'last-resort-visible-install' | 'default-fallback' | 'unmanaged-install';

export interface PackageManagerDetection {
  packageManager: PackageManager | 'electron';
  reason: DetectionReason | 'desktop-runtime';
  packagePath: string | null;
  packageManagerCommand: string | null;
  globalNodeModulesRoot: string | null;
}

export interface UpdateCheckOptions {
  appType?: string | undefined;
  platform?: string | undefined;
  arch?: string | undefined;
  deviceClass?: string | undefined;
  reportUsage?: boolean;
  installId?: string | undefined;
  instanceMode?: string | undefined;
  currentVersion?: VersionValue;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: VersionValue;
  version?: VersionValue;
  body?: string | undefined;
  releaseUrl?: string;
  downloadUrl?: string | undefined;
  nextSuggestedCheckInSec?: number | undefined;
  error?: string;
  packageManager?: PackageManager | 'electron';
  manualUpdate?: boolean;
  updateCommand?: string;
}

/** Runs a package-manager probe; tests inject one instead of spawning. */
type ProbeSpawn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;

export interface UpdateCommandOptions {
  targetVersion?: VersionValue;
  spawnSync?: ProbeSpawn;
}

export interface ExecuteUpdateOptions extends UpdateCommandOptions {
  silent?: boolean;
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const hasJsonFields = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object';
const isPackageManager = (value: string): value is PackageManager =>
  ['npm', 'pnpm', 'yarn', 'bun'].includes(value);

const PACKAGE_NAME = '@openchamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
// This build is developing-today's fork: its releases are the source for the update
// checks that it ships with (the Android app reads these directly).
const GITHUB_RELEASES_URL = 'https://github.com/developing-today-forks/openchamber/releases';
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/developing-today-forks/openchamber/releases';
// npm publishes upstream's @openchamber/web, so this build never installs updates through
// the package manager. The server and CLI report the fork release and the user installs it.
const FORK_RELEASES_LATEST_URL = `${GITHUB_RELEASES_URL}/latest`;
let cachedDetection: { packageManager: PackageManager; reason: DetectionReason; spawnSync: ProbeSpawn } | null = null;

const UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL || 'https://api.openchamber.dev/v1/update/check';
// Update answers are small JSON documents; anything past this cap is not one.
// The changelog index read in the same feature area caps at the same size.
const UPDATE_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

const isWellFormedVersion = (value: VersionValue) => {
  const [normalized = ''] = String(value || '').replace(/^v/, '').split('+');
  const core = normalized.split('-')[0] ?? '';
  return Boolean(core) && core.split('.').every((part) => /^\d+$/.test(part));
};

/**
 * Strict like versionParts in packages/ui mobileReleaseUpdate: an unparseable
 * version never claims an update, so '1junk' or '' cannot compare as a real
 * release.
 */
const compareVersions = (left: VersionValue, right: VersionValue) => (
  isWellFormedVersion(left) && isWellFormedVersion(right) ? compareVersionOrder(left, right) : 0
);

/**
 * Parses an update-check answer through the bounded reader, so an oversized
 * body cannot grow server memory while it streams in. An over-cap body reads
 * as `fallback` (the caller's existing failure value); a malformed body throws
 * from JSON.parse exactly as response.json() did.
 */
async function readUpdateJson<T>(response: Response, fallback: T): Promise<JsonValue | T> {
  // Test doubles pass a plain { ok, json } without a body; real responses go
  // through the bounded reader.
  if (!response.body) {
    return isFunction(response.json) ? response.json() : fallback;
  }
  const bounded = await readBoundedResponseText(response, UPDATE_RESPONSE_MAX_BYTES);
  if (bounded.tooLarge) return fallback;
  return JSON.parse(bounded.text);
}

function getOpenChamberConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }

  return path.join(os.homedir(), '.config', 'openchamber');
}

function sanitizeInstallScope(scope: string) {
  if (scope === 'desktop-electron' || scope === 'vscode' || scope === 'web' || scope === 'mobile-capacitor') return scope;
  return 'web';
}

function getOrCreateInstallId(scope = 'web') {
  const configDir = getOpenChamberConfigDir();
  const normalizedScope = sanitizeInstallScope(scope);
  const idPath = path.join(configDir, `install-id-${normalizedScope}`);

  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    void 0;
  }

  const installId = crypto.randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idPath, `${installId}\n`, { encoding: 'utf8', mode: 0o600 });
  return installId;
}

function mapPlatform(value: string) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
}

function mapArch(value: string) {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
}

function normalizeAppType(value: string | undefined) {
  if (value === 'web' || value === 'desktop-electron' || value === 'vscode' || value === 'mobile-capacitor') return value;
  return 'web';
}

function normalizeDeviceClass(value: string | undefined) {
  if (value === 'mobile' || value === 'tablet' || value === 'desktop' || value === 'unknown') return value;
  return 'unknown';
}

function normalizePlatform(value: string | undefined) {
  if (value === 'macos' || value === 'windows' || value === 'linux' || value === 'web' || value === 'android' || value === 'ios') return value;
  return mapPlatform(process.platform);
}

function normalizeArch(value: string | undefined) {
  if (value === 'arm64' || value === 'x64' || value === 'unknown') return value;
  return mapArch(process.arch);
}

async function resolveAndroidApkUrl(version: string, candidateUrl: string | undefined) {
  if (isString(candidateUrl)) {
    try {
      if (new URL(candidateUrl).pathname.toLowerCase().endsWith('.apk')) return candidateUrl;
    } catch {
      // Resolve malformed or non-APK values from the authoritative release assets below.
    }
  }

  try {
    const response = await fetch(`${GITHUB_RELEASES_API_URL}/tags/v${version}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openchamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return undefined;

    const release = await readUpdateJson(response, undefined);
    const apkAssets = (hasJsonFields(release) && Array.isArray(release.assets) ? release.assets : [])
      .filter(hasJsonFields)
      .flatMap((asset) => (
        isText(asset.name) && asset.name.toLowerCase().endsWith('.apk') && isText(asset.browser_download_url)
          ? [{ name: asset.name, url: asset.browser_download_url }]
          : []
      ));
    const canonicalAsset = apkAssets.find((asset) => /^OpenChamber-.+-android\.apk$/i.test(asset.name));
    return (canonicalAsset || apkAssets[0])?.url;
  } catch {
    return undefined;
  }
}

type ForkReleaseUpdate = {
  latestVersion: string;
  updateAvailable: true;
  releaseNotes?: string;
  releaseNotesUrl?: string;
};

async function postUpdateCheck<Payload extends object>(payload: Payload) {
  const response = await fetch(UPDATE_CHECK_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  return readUpdateJson(response, null);
}

/**
 * Latest published release of this fork, in the shape the update API returns. Drafts and
 * prereleases are skipped; the highest semver tag wins, not the most recently created one.
 */
async function fetchLatestForkRelease(): Promise<JsonObject | null> {
  const response = await fetch(`${GITHUB_RELEASES_API_URL}?per_page=30`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'openchamber-update-check',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;

  const releases = await readUpdateJson(response, null);
  if (!Array.isArray(releases)) return null;
  const published = releases
    .filter(hasJsonFields)
    .flatMap((release) => (
      !release.draft && !release.prerelease && isText(release.tag_name) && /^v\d+\.\d+\.\d+$/.test(release.tag_name)
        ? [{ release, version: release.tag_name.slice(1) }]
        : []
    ))
    .sort((left, right) => compareVersions(right.version, left.version));
  const latest = published[0];
  if (!latest) return null;

  const found: ForkReleaseUpdate = {
    latestVersion: latest.version,
    updateAvailable: true,
  };
  if (isText(latest.release.body)) found.releaseNotes = latest.release.body;
  if (isText(latest.release.html_url)) found.releaseNotesUrl = latest.release.html_url;
  return found;
}

async function checkForUpdatesFromApi(currentVersion: VersionValue, options: UpdateCheckOptions = {}) {
  try {
    const appType = normalizeAppType(options.appType);
    const hostPlatform = mapPlatform(process.platform);
    const hostArch = mapArch(process.arch);
    const shouldTrustClientPlatform = appType === 'desktop-electron' || appType === 'vscode' || appType === 'mobile-capacitor';
    const platform = shouldTrustClientPlatform ? normalizePlatform(options.platform) : hostPlatform;
    const arch = shouldTrustClientPlatform ? normalizeArch(options.arch) : hostArch;
    // Enterprise mode keeps the update check (security fixes must reach the
    // company) but never reports usage, whatever the client asked for.
    const reportUsage = options.reportUsage !== false && !isEnterpriseMode();
    const payload = {
      appType,
      deviceClass: normalizeDeviceClass(options.deviceClass),
      platform,
      arch,
      channel: 'stable',
      currentVersion,
      installId: reportUsage ? (options.installId || getOrCreateInstallId(appType)) : undefined,
      instanceMode: options.instanceMode || 'unknown',
      reportUsage,
    };

    const data = process.env.OPENCHAMBER_UPDATE_API_URL
      ? await postUpdateCheck(payload)
      : await fetchLatestForkRelease();
    if (!hasJsonFields(data) || !isText(data.latestVersion)) return null;

    const versionComparison = compareVersions(data.latestVersion, currentVersion);
    if (versionComparison < 0) return null;

    const releaseUrl = `${GITHUB_RELEASES_URL}/tag/v${data.latestVersion}`;
    const download = data.download;
    const downloadUrl = isText(data.downloadUrl)
      ? data.downloadUrl
      : hasJsonFields(download) && isText(download.url)
        ? download.url
        : undefined;
    const updateAvailable = Boolean(data.updateAvailable) && versionComparison > 0;
    const mobileDownloadUrl = updateAvailable && appType === 'mobile-capacitor' && platform === 'android'
      ? await resolveAndroidApkUrl(data.latestVersion, downloadUrl)
      : undefined;
    return {
      available: updateAvailable,
      version: data.latestVersion,
      currentVersion,
      body: isText(data.releaseNotes) ? data.releaseNotes : undefined,
      releaseUrl: isText(data.releaseNotesUrl) ? data.releaseNotesUrl : releaseUrl,
      downloadUrl: mobileDownloadUrl,
      nextSuggestedCheckInSec:
        isNumber(data.nextSuggestedCheckInSec) && Number.isFinite(data.nextSuggestedCheckInSec)
          ? data.nextSuggestedCheckInSec
          : undefined,
    };
  } catch {
    return null;
  }
}

function normalizePathForComparison(filePath: string) {
  if (!filePath) return null;
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getComparablePaths(filePath: string) {
  const paths = new Set<string>();
  const normalized = normalizePathForComparison(filePath);
  if (normalized) {
    paths.add(normalized);
  }

  try {
    const realPath = fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    const normalizedRealPath = normalizePathForComparison(realPath);
    if (normalizedRealPath) {
      paths.add(normalizedRealPath);
    }
  } catch {
    void 0;
  }

  return paths;
}

function pathSetContains(a: Set<string>, b: Set<string>) {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function getCurrentPackagePath(): string {
  return getWebPackagePaths().root;
}

function getPackagePathForGlobalRoot(rootPath: string) {
  if (!rootPath) return null;
  return path.join(rootPath, ...PACKAGE_PATH_SEGMENTS);
}

function getUniquePaths(paths: string[]) {
  const seen = new Set<string>();
  const result = [];
  for (const value of paths) {
    const normalized = normalizePathForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(value));
  }
  return result;
}

function getCommandOutput(command: string, args: string[], spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  try {
    const result = spawnSyncImpl(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) {
      return null;
    }

    const stdout = result.stdout.trim();
    return stdout || null;
  } catch {
    return null;
  }
}

function getGlobalBinDirs(pm: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  const pmCommand = resolvePackageManagerCommand(pm, spawnSyncImpl);
  if (!isCommandAvailable(pmCommand, spawnSyncImpl)) {
    return [];
  }

  const dirs = [];
  switch (pm) {
    case 'pnpm': {
      const pnpmBin = getCommandOutput(pmCommand, ['bin', '-g'], spawnSyncImpl);
      if (pnpmBin) dirs.push(pnpmBin);
      const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g'], spawnSyncImpl);
      if (pnpmPrefix) dirs.push(process.platform === 'win32' ? pnpmPrefix : path.join(pnpmPrefix, 'bin'));
      break;
    }
    case 'yarn': {
      const yarnBin = getCommandOutput(pmCommand, ['global', 'bin'], spawnSyncImpl);
      if (yarnBin) dirs.push(yarnBin);
      break;
    }
    case 'bun': {
      const bunBin = getCommandOutput(pmCommand, ['pm', 'bin', '-g'], spawnSyncImpl);
      if (bunBin) dirs.push(bunBin);
      break;
    }
    default: {
      const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g'], spawnSyncImpl);
      if (npmPrefix) dirs.push(process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin'));
      break;
    }
  }

  return getUniquePaths(dirs);
}

function getGlobalNodeModulesRoots(pm: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm, spawnSyncImpl);
    if (!isCommandAvailable(pmCommand, spawnSyncImpl)) {
      return [];
    }

    const roots = [];

    switch (pm) {
      case 'pnpm': {
        const pnpmRoot = getCommandOutput(pmCommand, ['root', '-g'], spawnSyncImpl);
        if (pnpmRoot) roots.push(pnpmRoot);
        const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g'], spawnSyncImpl);
        if (pnpmPrefix) roots.push(process.platform === 'win32' ? path.join(pnpmPrefix, 'node_modules') : path.join(pnpmPrefix, 'lib', 'node_modules'));
        break;
      }
      case 'yarn': {
        const yarnDir = getCommandOutput(pmCommand, ['global', 'dir'], spawnSyncImpl);
        if (yarnDir) roots.push(path.join(yarnDir, 'node_modules'));
        break;
      }
      case 'bun': {
        const bunBinDir = getCommandOutput(pmCommand, ['pm', 'bin', '-g'], spawnSyncImpl);
        if (bunBinDir) {
          roots.push(path.resolve(bunBinDir, '..', 'install', 'global', 'node_modules'));
          roots.push(path.resolve(bunBinDir, '..', '..', 'node_modules'));
        }
        break;
      }
      default:
      {
        const npmRoot = getCommandOutput(pmCommand, ['root', '-g'], spawnSyncImpl);
        if (npmRoot) roots.push(npmRoot);
        const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g'], spawnSyncImpl);
        if (npmPrefix) roots.push(process.platform === 'win32' ? path.join(npmPrefix, 'node_modules') : path.join(npmPrefix, 'lib', 'node_modules'));
        break;
      }
    }

    return getUniquePaths(roots);
  } catch {
    return [];
  }
}

function getOwnedPackagePathsFromGlobalBins(pm: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm, spawnSyncImpl)) {
    const binaryName = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    const binaryPath = path.join(binDir, binaryName);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      const realBinaryPath = fs.realpathSync.native ? fs.realpathSync.native(binaryPath) : fs.realpathSync(binaryPath);
      packagePaths.push(getWebPackagePaths(pathToFileURL(realBinaryPath).href).root);
    } catch {
      void 0;
    }
  }

  return getUniquePaths(packagePaths);
}

function detectPackageManagerFromCurrentInstallPath() {
  return detectPackageManagerFromInstallPath(getCurrentPackagePath());
}

function packageManagerOwnsCurrentInstall(pm: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  const currentPackagePaths = getComparablePaths(getCurrentPackagePath());
  const candidatePackagePaths = [
    ...getGlobalNodeModulesRoots(pm, spawnSyncImpl).map(getPackagePathForGlobalRoot),
    ...getOwnedPackagePathsFromGlobalBins(pm, spawnSyncImpl),
  ];

  for (const candidatePath of candidatePackagePaths) {
    if (!candidatePath) continue;
    if (pathSetContains(currentPackagePaths, getComparablePaths(candidatePath))) {
      return true;
    }
  }

  return false;
}

function describeDetection(packageManager: PackageManager, reason: DetectionReason, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe): PackageManagerDetection {
  return {
    packageManager,
    reason,
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(packageManager, spawnSyncImpl),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(packageManager, spawnSyncImpl)[0] || null,
  };
}

function rememberDetection(packageManager: PackageManager, reason: DetectionReason, spawnSyncImpl: ProbeSpawn) {
  cachedDetection = { packageManager, reason, spawnSync: spawnSyncImpl };
  return describeDetection(packageManager, reason, spawnSyncImpl);
}

export function detectPackageManagerDetails({ spawnSync: spawnSyncImpl = spawnPackageManagerProbe }: { spawnSync?: ProbeSpawn } = {}): PackageManagerDetection {
  if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
    return {
      packageManager: 'electron',
      reason: 'desktop-runtime',
      packagePath: null,
      packageManagerCommand: null,
      globalNodeModulesRoot: null,
    };
  }

  if (cachedDetection) {
    return describeDetection(cachedDetection.packageManager, cachedDetection.reason, cachedDetection.spawnSync);
  }

  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && isPackageManager(forcedPm)) {
    if (isCommandAvailable(resolvePackageManagerCommand(forcedPm, spawnSyncImpl), spawnSyncImpl)) {
      return rememberDetection(forcedPm, 'forced-env', spawnSyncImpl);
    }
  }

  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm, spawnSyncImpl)) {
    return rememberDetection(installPathPm, 'install-path-owner', spawnSyncImpl);
  }

  const ownershipCandidates: PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate, spawnSyncImpl)) {
      return rememberDetection(candidate, 'global-root-owner', spawnSyncImpl);
    }
  }

  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm: PackageManager | null = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  const invokedPm = detectPackageManagerFromInvocationPath(process.argv?.[1]);
  if (!hintedPm) {
    hintedPm = invokedPm;
  }

  if (!hintedPm) {
    hintedPm = installPathPm;
  }

  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm, spawnSyncImpl), spawnSyncImpl) && isPackageInstalledWith(hintedPm, spawnSyncImpl)) {
    return rememberDetection(hintedPm, 'hinted-visible-install', spawnSyncImpl);
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm, spawnSyncImpl), spawnSyncImpl) && isPackageInstalledWith(runtimePm, spawnSyncImpl)) {
    return rememberDetection(runtimePm, 'runtime-visible-install', spawnSyncImpl);
  }

  const pmChecks: { name: PackageManager; check: () => boolean }[] = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm', spawnSyncImpl), spawnSyncImpl) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn', spawnSyncImpl), spawnSyncImpl) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun', spawnSyncImpl), spawnSyncImpl) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm', spawnSyncImpl), spawnSyncImpl) },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      if (isPackageInstalledWith(name, spawnSyncImpl)) {
        return rememberDetection(name, 'last-resort-visible-install', spawnSyncImpl);
      }
    }
  }

  return rememberDetection('npm', installPathPm ? 'default-fallback' : 'unmanaged-install', spawnSyncImpl);
}

export function isUnmanagedInstall() {
  return (cachedDetection ?? detectPackageManagerDetails()).reason === 'unmanaged-install';
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

function detectPackageManagerFromInstallPath(pkgPath: string) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/') || normalized.includes('/pnpm-store/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/')) return 'bun';
  if (normalized.includes('/node_modules/')) return 'npm';
  return null;
}

function detectPackageManagerFromRuntimePath(runtimePath: string) {
  if (!runtimePath) return null;
  const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/bun') || normalized.endsWith('/bun') || normalized.endsWith('/bun.exe')) {
    return 'bun';
  }
  if (normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/yarn/')) return 'yarn';
  if (normalized.includes('/node') || normalized.endsWith('/node.exe')) return 'npm';
  return null;
}

function detectPackageManagerFromInvocationPath(invokedPath: string | undefined) {
  if (!invokedPath) return null;
  const normalized = invokedPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (normalized.includes('/.pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  return null;
}

function getPackageManagerCommandCandidates(pm: string) {
  const candidates = [];
  if (pm === 'bun') {
    const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';
    if (process.env.BUN_INSTALL) {
      candidates.push(path.join(process.env.BUN_INSTALL, 'bin', bunExecutable));
    }
    if (process.env.HOME) {
      candidates.push(path.join(process.env.HOME, '.bun', 'bin', bunExecutable));
    }
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, '.bun', 'bin', bunExecutable));
    }
  }
  candidates.push(pm);
  return [...new Set(candidates.filter(Boolean))];
}

function resolvePackageManagerCommand(pm: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate, spawnSyncImpl)) {
      return candidate;
    }
  }
  return pm;
}

function quoteCommand(command: string) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  try {
    const result = spawnSyncImpl(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      ...getSpawnSyncBaseOptions(),
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function getGlobalListArgs(pm: string) {
  switch (pm) {
    case 'pnpm':
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
    case 'yarn':
      return ['global', 'list', '--depth=0'];
    case 'bun':
      return ['pm', 'ls', '-g'];
    default:
      return ['list', '-g', '--depth=0', PACKAGE_NAME];
  }
}

function isPackageInstalledWith(pm: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm, spawnSyncImpl);
    const args = getGlobalListArgs(pm);

    const result = spawnSyncImpl(pmCommand, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });

    if (result.status !== 0) return false;
    return result.stdout.includes(PACKAGE_NAME) || result.stdout.includes('openchamber');
  } catch {
    return false;
  }
}

function normalizeTargetVersion(value: VersionValue) {
  const normalized = String(value ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

const PNPM_BUILD_DEPENDENCIES = ['msgpackr-extract', 'node-pty'];
const PNPM_ALLOW_BUILD_MIN_VERSION = '10.4.0';

function getPnpmAllowBuildFlags(pmCommand: string, spawnSyncImpl: ProbeSpawn = spawnPackageManagerProbe) {
  const version = normalizeTargetVersion(getCommandOutput(pmCommand, ['--version'], spawnSyncImpl));
  if (!version || compareVersions(version, PNPM_ALLOW_BUILD_MIN_VERSION) < 0) return '';
  return PNPM_BUILD_DEPENDENCIES.map((name) => ` --allow-build=${name}`).join('');
}

export function getUpdateCommand(pm: string = detectPackageManager(), options: UpdateCommandOptions = {}) {
  const targetVersion = normalizeTargetVersion(options.targetVersion);
  if (options.targetVersion != null && !targetVersion) {
    throw new Error(`Invalid target version for update: ${String(options.targetVersion)}`);
  }
  const versionSpec = targetVersion ? `@${targetVersion}` : '@latest';
  const spawnSyncImpl = options.spawnSync ?? spawnPackageManagerProbe;
  const resolvedCommand = resolvePackageManagerCommand(pm, spawnSyncImpl);
  const pmCommand = quoteCommand(resolvedCommand);
  switch (pm) {
    case 'pnpm':
      return `${pmCommand} add -g${getPnpmAllowBuildFlags(resolvedCommand, spawnSyncImpl)} ${PACKAGE_NAME}${versionSpec}`;
    case 'yarn':
      return `${pmCommand} global add ${PACKAGE_NAME}${versionSpec}`;
    case 'bun':
      return `${pmCommand} add -g ${PACKAGE_NAME}${versionSpec}`;
    default:
      return `${pmCommand} install -g ${PACKAGE_NAME}${versionSpec}`;
  }
}

export function getCurrentVersion() {
  try {
    const pkgPath = getWebPackagePaths().packageJson;
    const pkg: JsonValue = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return (hasJsonFields(pkg) && pkg.version) || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function fetchRequiredOpenCodeVersion(version: VersionValue) {
  const target = normalizeTargetVersion(version);
  if (!target) return null;
  try {
    const request = resolveNpmRegistryRequest(PACKAGE_NAME, target);
    const response = await fetch(request.url, {
      headers: { Accept: 'application/json', ...request.headers },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data: JsonValue = await response.json();
    const engines = hasJsonFields(data) ? data.engines : undefined;
    return /^>=\s*v?(\d+\.\d+\.\d+)$/.exec(String((hasJsonFields(engines) ? engines.opencode : undefined) ?? '').trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();

  if (currentVersion === 'unknown') {
    return { available: false, currentVersion, error: 'Unable to determine versions' };
  }

  // No npm fallback: the registry only has upstream's package, so an unreachable release
  // feed means no update is reported rather than upstream's version.
  const remote = await checkForUpdatesFromApi(currentVersion, options);
  if (!remote) {
    return { available: false, currentVersion, error: 'Unable to reach the release feed' };
  }

  return {
    ...remote,
    packageManager: pm,
    manualUpdate: true,
    updateCommand: `Download the release from ${remote.releaseUrl || FORK_RELEASES_LATEST_URL}`,
  };
}

export function executeUpdate(_pm: string = detectPackageManager(), options: ExecuteUpdateOptions = {}) {
  const version = normalizeTargetVersion(options.targetVersion);
  return {
    success: false,
    exitCode: null,
    manualUpdate: true,
    error: `Install the new release by hand from ${FORK_RELEASES_LATEST_URL}${version ? ` (v${version})` : ''}; this build does not update through npm`,
  };
}
