import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { getWebPackagePaths } from './web-package-paths.js';
import { fetchUpdateNotes } from './changelog/update-notes.js';
import { compareVersions } from './version-order.js';
import { isEnterpriseMode } from './enterprise-mode.js';
import { getSpawnSyncBaseOptions, spawnPackageManagerProbe } from './package-manager-probe.js';

import { resolveNpmRegistryRequest } from './npm/npm-registry-config.js';
import type { JsonObject, JsonValue } from './shared/json-values.js';

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
  updateCommand?: string;
}

export interface UpdateCommandOptions {
  targetVersion?: VersionValue;
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
const GITHUB_RELEASES_URL = 'https://github.com/openchamber/openchamber/releases';
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/openchamber/openchamber/releases';
let cachedDetection: { packageManager: PackageManager; reason: DetectionReason } | null = null;

const UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL || 'https://api.openchamber.dev/v1/update/check';

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

const CANARY_MIRROR_URL = 'https://downloads.openchamber.dev/desktop/canary/';

const CANARY_ANDROID_APK_RE = /^OpenChamber-(\d+\.\d+\.\d+-canary\.\d+\.\d+)-\d+-android\.apk$/;

async function fetchCanaryAndroidApk() {
  try {
    const response = await fetch(`${GITHUB_RELEASES_API_URL}/tags/canary`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'openchamber-update-check',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) return { newest: null };
    if (!response.ok) return null;

    const release: JsonValue = await response.json();
    let newest: { version: string; name: string; url: string } | null = null;
    for (const asset of hasJsonFields(release) && Array.isArray(release.assets) ? release.assets : []) {
      const match = hasJsonFields(asset) && isText(asset.name) ? CANARY_ANDROID_APK_RE.exec(asset.name) : null;
      if (!match || match[1] === undefined || !hasJsonFields(asset) || !isText(asset.name) || !isText(asset.browser_download_url)) continue;
      if (!newest || compareVersions(match[1], newest.version) > 0) {
        newest = { version: match[1], name: asset.name, url: asset.browser_download_url };
      }
    }
    if (!newest) return { newest: null };
    const mirrorUrl = `${CANARY_MIRROR_URL}${newest.name}`;
    const mirrored = await fetch(mirrorUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).then((head) => head.ok, () => false);
    return { newest: { version: newest.version, url: mirrored ? mirrorUrl : newest.url } };
  } catch {
    return null;
  }
}

async function checkForUpdatesFromApi(currentVersion: VersionValue, options: UpdateCheckOptions = {}) {
  try {
    const appType = normalizeAppType(options.appType);
    const hostPlatform = mapPlatform(process.platform);
    const hostArch = mapArch(process.arch);
    const shouldTrustClientPlatform = appType === 'desktop-electron' || appType === 'vscode' || appType === 'mobile-capacitor';
    const platform = shouldTrustClientPlatform ? normalizePlatform(options.platform) : hostPlatform;
    const arch = shouldTrustClientPlatform ? normalizeArch(options.arch) : hostArch;
    const reportUsage = options.reportUsage !== false && !isEnterpriseMode();
    const payload = {
      appType,
      deviceClass: normalizeDeviceClass(options.deviceClass),
      platform,
      arch,
      channel: /-canary\./.test(String(currentVersion)) ? 'canary' : 'stable',
      currentVersion,
      installId: reportUsage ? (options.installId || getOrCreateInstallId(appType)) : undefined,
      instanceMode: options.instanceMode || 'unknown',
      reportUsage,
    };

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
    const data: JsonValue = await response.json();
    if (!hasJsonFields(data) || !isText(data.latestVersion)) return null;

    const versionComparison = compareVersions(data.latestVersion, currentVersion);
    if (versionComparison < 0) return null;

    const releaseUrl = `${GITHUB_RELEASES_URL}/tag/v${data.latestVersion}`;
    const updateAvailable = Boolean(data.updateAvailable) && versionComparison > 0;
    return {
      available: updateAvailable,
      version: data.latestVersion,
      currentVersion,
      body: isText(data.releaseNotes) ? data.releaseNotes : undefined,
      releaseUrl: isText(data.releaseNotesUrl) ? data.releaseNotesUrl : releaseUrl,
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

function getCommandOutput(command: string, args: string[]) {
  try {
    const result = spawnPackageManagerProbe(command, args, {
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

function getGlobalBinDirs(pm: string) {
  const pmCommand = resolvePackageManagerCommand(pm);
  if (!isCommandAvailable(pmCommand)) {
    return [];
  }

  const dirs = [];
  switch (pm) {
    case 'pnpm': {
      const pnpmBin = getCommandOutput(pmCommand, ['bin', '-g']);
      if (pnpmBin) dirs.push(pnpmBin);
      const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (pnpmPrefix) dirs.push(process.platform === 'win32' ? pnpmPrefix : path.join(pnpmPrefix, 'bin'));
      break;
    }
    case 'yarn': {
      const yarnBin = getCommandOutput(pmCommand, ['global', 'bin']);
      if (yarnBin) dirs.push(yarnBin);
      break;
    }
    case 'bun': {
      const bunBin = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
      if (bunBin) dirs.push(bunBin);
      break;
    }
    default: {
      const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
      if (npmPrefix) dirs.push(process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin'));
      break;
    }
  }

  return getUniquePaths(dirs);
}

function getGlobalNodeModulesRoots(pm: string) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    if (!isCommandAvailable(pmCommand)) {
      return [];
    }

    const roots = [];

    switch (pm) {
      case 'pnpm': {
        const pnpmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (pnpmRoot) roots.push(pnpmRoot);
        const pnpmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (pnpmPrefix) roots.push(process.platform === 'win32' ? path.join(pnpmPrefix, 'node_modules') : path.join(pnpmPrefix, 'lib', 'node_modules'));
        break;
      }
      case 'yarn': {
        const yarnDir = getCommandOutput(pmCommand, ['global', 'dir']);
        if (yarnDir) roots.push(path.join(yarnDir, 'node_modules'));
        break;
      }
      case 'bun': {
        const bunBinDir = getCommandOutput(pmCommand, ['pm', 'bin', '-g']);
        if (bunBinDir) {
          roots.push(path.resolve(bunBinDir, '..', 'install', 'global', 'node_modules'));
          roots.push(path.resolve(bunBinDir, '..', '..', 'node_modules'));
        }
        break;
      }
      default:
      {
        const npmRoot = getCommandOutput(pmCommand, ['root', '-g']);
        if (npmRoot) roots.push(npmRoot);
        const npmPrefix = getCommandOutput(pmCommand, ['prefix', '-g']);
        if (npmPrefix) roots.push(process.platform === 'win32' ? path.join(npmPrefix, 'node_modules') : path.join(npmPrefix, 'lib', 'node_modules'));
        break;
      }
    }

    return getUniquePaths(roots);
  } catch {
    return [];
  }
}

function getOwnedPackagePathsFromGlobalBins(pm: string) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm)) {
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

function packageManagerOwnsCurrentInstall(pm: string) {
  const currentPackagePaths = getComparablePaths(getCurrentPackagePath());
  const candidatePackagePaths = [
    ...getGlobalNodeModulesRoots(pm).map(getPackagePathForGlobalRoot),
    ...getOwnedPackagePathsFromGlobalBins(pm),
  ];

  for (const candidatePath of candidatePackagePaths) {
    if (!candidatePath) continue;
    if (pathSetContains(currentPackagePaths, getComparablePaths(candidatePath))) {
      return true;
    }
  }

  return false;
}

function describeDetection(packageManager: PackageManager, reason: DetectionReason): PackageManagerDetection {
  return {
    packageManager,
    reason,
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(packageManager),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(packageManager)[0] || null,
  };
}

function rememberDetection(packageManager: PackageManager, reason: DetectionReason) {
  cachedDetection = { packageManager, reason };
  return describeDetection(packageManager, reason);
}

export function detectPackageManagerDetails(): PackageManagerDetection {
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
    return describeDetection(cachedDetection.packageManager, cachedDetection.reason);
  }

  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && isPackageManager(forcedPm)) {
    if (isCommandAvailable(resolvePackageManagerCommand(forcedPm))) {
      return rememberDetection(forcedPm, 'forced-env');
    }
  }

  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm)) {
    return rememberDetection(installPathPm, 'install-path-owner');
  }

  const ownershipCandidates: PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate)) {
      return rememberDetection(candidate, 'global-root-owner');
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

  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm)) && isPackageInstalledWith(hintedPm)) {
    return rememberDetection(hintedPm, 'hinted-visible-install');
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm)) && isPackageInstalledWith(runtimePm)) {
    return rememberDetection(runtimePm, 'runtime-visible-install');
  }

  const pmChecks: { name: PackageManager; check: () => boolean }[] = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm')) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn')) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun')) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm')) },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      if (isPackageInstalledWith(name)) {
        return rememberDetection(name, 'last-resort-visible-install');
      }
    }
  }

  return rememberDetection('npm', installPathPm ? 'default-fallback' : 'unmanaged-install');
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

function resolvePackageManagerCommand(pm: string) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) {
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

function isCommandAvailable(command: string) {
  try {
    const result = spawnPackageManagerProbe(command, ['--version'], {
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

function isPackageInstalledWith(pm: string) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const args = getGlobalListArgs(pm);

    const result = spawnPackageManagerProbe(pmCommand, args, {
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

const GLOBAL_VERSION_PATTERN = /@openchamber\/web[@\s]+v?(\d[\w.+-]*)/;

function getInstalledGlobalVersion(pm: string) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const result = spawnPackageManagerProbe(pmCommand, getGlobalListArgs(pm), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
      ...getSpawnSyncBaseOptions(),
    });
    return String(result.stdout || '').match(GLOBAL_VERSION_PATTERN)?.[1] || null;
  } catch {
    return null;
  }
}

function normalizeTargetVersion(value: VersionValue) {
  const normalized = String(value ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

const PNPM_BUILD_DEPENDENCIES = ['msgpackr-extract', 'node-pty'];
const PNPM_ALLOW_BUILD_MIN_VERSION = '10.4.0';

function getPnpmAllowBuildFlags(pmCommand: string) {
  const version = normalizeTargetVersion(getCommandOutput(pmCommand, ['--version']));
  if (!version || compareVersions(version, PNPM_ALLOW_BUILD_MIN_VERSION) < 0) return '';
  return PNPM_BUILD_DEPENDENCIES.map((name) => ` --allow-build=${name}`).join('');
}

export function getUpdateCommand(pm: string = detectPackageManager(), options: UpdateCommandOptions = {}) {
  const targetVersion = normalizeTargetVersion(options.targetVersion);
  if (options.targetVersion != null && !targetVersion) {
    throw new Error(`Invalid target version for update: ${String(options.targetVersion)}`);
  }
  const versionSpec = targetVersion ? `@${targetVersion}` : '@latest';
  const resolvedCommand = resolvePackageManagerCommand(pm);
  const pmCommand = quoteCommand(resolvedCommand);
  switch (pm) {
    case 'pnpm':
      return `${pmCommand} add -g${getPnpmAllowBuildFlags(resolvedCommand)} ${PACKAGE_NAME}${versionSpec}`;
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

const UPDATE_CHANNELS = new Set(['stable', 'canary']);

const isCanaryVersion = (version: VersionValue) => /-canary\./.test(String(version || ''));

function getSettingsFilePath() {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR?.trim();
  return path.join(dataDir ? path.resolve(dataDir) : path.join(os.homedir(), '.config', 'openchamber'), 'settings.json');
}

export function readUpdateChannel(currentVersion = getCurrentVersion()) {
  try {
    const settings: JsonValue = JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8'));
    if (hasJsonFields(settings) && isText(settings.serverUpdateChannel) && UPDATE_CHANNELS.has(settings.serverUpdateChannel)) return settings.serverUpdateChannel;
  } catch {
    void 0;
  }
  return isCanaryVersion(currentVersion) ? 'canary' : 'stable';
}

async function fetchDistTags() {
  try {
    const request = resolveNpmRegistryRequest(PACKAGE_NAME);
    const response = await fetch(request.url, {
      headers: { Accept: 'application/json', ...request.headers },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    const data: JsonValue = await response.json();
    return (hasJsonFields(data) ? data['dist-tags'] : undefined) ?? {};
  } catch {
    return null;
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

async function getLatestVersion() {
  const tags = await fetchDistTags();
  return (hasJsonFields(tags) && tags.latest) || null;
}

async function fetchChangelogNotes(fromVersion: VersionValue, toVersion: VersionValue) {
  return (await fetchUpdateNotes<VersionValue>(fromVersion, toVersion, compareVersions)) ?? undefined;
}

async function checkChannelForUpdates(channel: string, currentVersion: VersionValue, options: UpdateCheckOptions) {
  const [, distTags] = await Promise.all([
    checkForUpdatesFromApi(currentVersion, options),
    fetchDistTags(),
  ]);
  if (!distTags) {
    return { available: false, currentVersion, error: 'Unable to determine versions' };
  }
  const target = normalizeTargetVersion(hasJsonFields(distTags) ? (channel === 'canary' ? distTags.canary : distTags.latest) : undefined);
  if (!target) {
    return { available: false, currentVersion };
  }
  const available = channel === 'canary' ? compareVersions(target, currentVersion) > 0 : target !== currentVersion;
  return {
    available,
    version: target,
    currentVersion,
    body: available ? await fetchChangelogNotes(currentVersion, target) : undefined,
    releaseUrl: channel === 'canary' ? `${GITHUB_RELEASES_URL}/tag/canary` : `${GITHUB_RELEASES_URL}/tag/v${target}`,
  };
}

export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();
  const appType = normalizeAppType(options.appType);
  const platform = normalizePlatform(options.platform);

  if (appType === 'web' && currentVersion !== 'unknown') {
    const channel = readUpdateChannel(currentVersion);
    if (channel === 'canary' || isCanaryVersion(currentVersion)) {
      return {
        ...await checkChannelForUpdates(channel, currentVersion, options),
        packageManager: pm,
        updateCommand: 'openchamber update',
      };
    }
  }

  if (appType === 'mobile-capacitor' && platform === 'android' && currentVersion !== 'unknown') {
    const [, canary] = await Promise.all([
      checkForUpdatesFromApi(currentVersion, options),
      fetchCanaryAndroidApk(),
    ]);
    if (!canary) {
      return { available: false, currentVersion, error: 'Unable to determine versions' };
    }
    const available = canary.newest !== null && compareVersions(canary.newest.version, currentVersion) > 0;
    return {
      available,
      version: canary.newest?.version,
      currentVersion,
      body: available && canary.newest ? await fetchChangelogNotes(currentVersion, canary.newest.version) : undefined,
      releaseUrl: `${GITHUB_RELEASES_URL}/tag/canary`,
      downloadUrl: available && canary.newest ? canary.newest.url : undefined,
    };
  }

  if (currentVersion !== 'unknown') {
    const remote = await checkForUpdatesFromApi(currentVersion, options);
    if (remote) {
      if (remote.available && appType === 'web') {
        const npmLatest = await getLatestVersion();
        if (!npmLatest || compareVersions(npmLatest, remote.version) < 0) {
          remote.available = false;
        }
      }
      return {
        ...remote,
        packageManager: pm,
        updateCommand: 'openchamber update',
      };
    }
  }

  const latestVersion = await getLatestVersion();

  if (!latestVersion || currentVersion === 'unknown') {
    return {
      available: false,
      currentVersion,
      error: 'Unable to determine versions',
    };
  }

  const available = compareVersions(latestVersion, currentVersion) > 0;
  const changelog = available ? await fetchChangelogNotes(currentVersion, latestVersion) : undefined;

  return {
    available,
    version: latestVersion,
    currentVersion,
    body: changelog,
    releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${latestVersion}`,
    packageManager: pm,
    updateCommand: 'openchamber update',
  };
}

export function executeUpdate(pm: string = detectPackageManager(), options: ExecuteUpdateOptions = {}) {
  const command = getUpdateCommand(pm, { targetVersion: options.targetVersion });
  if (!options?.silent) {
    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
    console.log(`Running: ${command}`);
  }

  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    ...getSpawnSyncBaseOptions(),
  });

  if (result.status !== 0) {
    return {
      success: false,
      exitCode: result.status,
      error: `Package manager exited with code ${result.status}`,
    };
  }

  const targetVersion = normalizeTargetVersion(options.targetVersion);
  if (!targetVersion) {
    return {
      success: true,
      exitCode: result.status,
      installedVersion: null,
    };
  }

  const installedVersion = getInstalledGlobalVersion(pm);
  if (!installedVersion) {
    return {
      success: false,
      exitCode: result.status,
      error: `Could not determine the globally installed ${PACKAGE_NAME} version after the update; not reporting success`,
    };
  }

  if (compareVersions(installedVersion, targetVersion) !== 0) {
    return {
      success: false,
      exitCode: result.status,
      error: `Installed ${PACKAGE_NAME} version ${installedVersion} does not match target ${targetVersion}. The package manager may have resolved different metadata or filtered the release.`,
    };
  }

  return {
    success: true,
    exitCode: result.status,
    installedVersion,
  };
}
