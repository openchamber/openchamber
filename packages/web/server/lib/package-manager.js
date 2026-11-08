import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchUpdateNotes } from './changelog/update-notes.js';
import { compareVersions } from './version-order.js';
import { isEnterpriseMode } from './enterprise-mode.js';

import { resolveNpmRegistryRequest } from './opencode/npm-registry-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = '@openchamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
const GITHUB_RELEASES_URL = 'https://github.com/openchamber/openchamber/releases';
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/openchamber/openchamber/releases';
// The reason is kept with the package manager: a later call must still tell
// a copy no package manager installed from one it did.
let cachedDetection = null;

function getSpawnSyncBaseOptions() {
  return process.platform === 'win32' ? { windowsHide: true } : {};
}
const UPDATE_CHECK_URL = process.env.OPENCHAMBER_UPDATE_API_URL || 'https://api.openchamber.dev/v1/update/check';

function getOpenChamberConfigDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }

  return path.join(os.homedir(), '.config', 'openchamber');
}

function sanitizeInstallScope(scope) {
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
    // Generate new id.
  }

  const installId = crypto.randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idPath, `${installId}\n`, { encoding: 'utf8', mode: 0o600 });
  return installId;
}

function mapPlatform(value) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
}

function mapArch(value) {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
}

function normalizeAppType(value) {
  if (value === 'web' || value === 'desktop-electron' || value === 'vscode' || value === 'mobile-capacitor') return value;
  return 'web';
}

function normalizeDeviceClass(value) {
  if (value === 'mobile' || value === 'tablet' || value === 'desktop' || value === 'unknown') return value;
  return 'unknown';
}

function normalizePlatform(value) {
  if (value === 'macos' || value === 'windows' || value === 'linux' || value === 'web' || value === 'android' || value === 'ios') return value;
  return mapPlatform(process.platform);
}

function normalizeArch(value) {
  if (value === 'arm64' || value === 'x64' || value === 'unknown') return value;
  return mapArch(process.arch);
}

// The Android APK the Canary workflow puts in the canary pre-release.
const CANARY_ANDROID_APK_RE = /^OpenChamber-(\d+\.\d+\.\d+-canary\.\d+\.\d+)-\d+-android\.apk$/;

/**
 * The newest Android APK in the canary pre-release: `{ newest }`, where
 * newest is null when none is published, or null when GitHub could not be read.
 */
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

    const release = await response.json();
    let newest = null;
    for (const asset of Array.isArray(release?.assets) ? release.assets : []) {
      const match = typeof asset?.name === 'string' ? CANARY_ANDROID_APK_RE.exec(asset.name) : null;
      if (!match || typeof asset.browser_download_url !== 'string') continue;
      if (!newest || compareVersions(match[1], newest.version) > 0) {
        newest = { version: match[1], url: asset.browser_download_url };
      }
    }
    return { newest };
  } catch {
    return null;
  }
}

async function checkForUpdatesFromApi(currentVersion, options = {}) {
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
      // A Canary build (2.5.4-canary.20261030.123) checks in as such, so the
      // usage counts tell the channels apart. Updates themselves come from
      // the desktop updater, which reads the channel the person chose.
      channel: /-canary\./.test(currentVersion) ? 'canary' : 'stable',
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
    const data = await response.json();
    if (typeof data?.latestVersion !== 'string') return null;

    const versionComparison = compareVersions(data.latestVersion, currentVersion);
    if (versionComparison < 0) return null;

    const releaseUrl = `${GITHUB_RELEASES_URL}/tag/v${data.latestVersion}`;
    const updateAvailable = Boolean(data.updateAvailable) && versionComparison > 0;
    return {
      available: updateAvailable,
      version: data.latestVersion,
      currentVersion,
      body: typeof data.releaseNotes === 'string' ? data.releaseNotes : undefined,
      releaseUrl: typeof data.releaseNotesUrl === 'string' ? data.releaseNotesUrl : releaseUrl,
      nextSuggestedCheckInSec:
        typeof data.nextSuggestedCheckInSec === 'number' && Number.isFinite(data.nextSuggestedCheckInSec)
          ? data.nextSuggestedCheckInSec
          : undefined,
    };
  } catch {
    return null;
  }
}

function normalizePathForComparison(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getComparablePaths(filePath) {
  const paths = new Set();
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
  }

  return paths;
}

function pathSetContains(a, b) {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function getCurrentPackagePath() {
  return path.resolve(__dirname, '..', '..');
}

function getPackagePathForGlobalRoot(rootPath) {
  if (!rootPath) return null;
  return path.join(rootPath, ...PACKAGE_PATH_SEGMENTS);
}

function getUniquePaths(paths) {
  const seen = new Set();
  const result = [];
  for (const value of paths) {
    const normalized = normalizePathForComparison(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path.resolve(value));
  }
  return result;
}

function getCommandOutput(command, args) {
  try {
    const result = spawnSync(command, args, {
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

function getGlobalBinDirs(pm) {
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

function getGlobalNodeModulesRoots(pm) {
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

function getOwnedPackagePathsFromGlobalBins(pm) {
  const packagePaths = [];
  for (const binDir of getGlobalBinDirs(pm)) {
    const binaryName = process.platform === 'win32' ? 'openchamber.cmd' : 'openchamber';
    const binaryPath = path.join(binDir, binaryName);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      const realBinaryPath = fs.realpathSync.native ? fs.realpathSync.native(binaryPath) : fs.realpathSync(binaryPath);
      packagePaths.push(path.resolve(realBinaryPath, '..', '..'));
    } catch {
    }
  }

  return getUniquePaths(packagePaths);
}

function detectPackageManagerFromCurrentInstallPath() {
  return detectPackageManagerFromInstallPath(getCurrentPackagePath());
}

function packageManagerOwnsCurrentInstall(pm) {
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

function describeDetection(packageManager, reason) {
  return {
    packageManager,
    reason,
    packagePath: getCurrentPackagePath(),
    packageManagerCommand: resolvePackageManagerCommand(packageManager),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(packageManager)[0] || null,
  };
}

function rememberDetection(packageManager, reason) {
  cachedDetection = { packageManager, reason };
  return describeDetection(packageManager, reason);
}

export function detectPackageManagerDetails() {
  // In desktop (Electron) runtime, package-manager detection is worthless —
  // the app ships as a .app bundle, not installed via npm/pnpm/yarn/bun, and
  // updates are handled by electron-updater. The detection path does up to a
  // dozen spawnSync(pm, ['bin', '-g']) calls with 10s timeouts each; under
  // the in-process server every one blocks the Electron main event loop and
  // manifests as a multi-second UI freeze. Short-circuit here.
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
  if (forcedPm && ['npm', 'pnpm', 'yarn', 'bun'].includes(forcedPm)) {
    if (isCommandAvailable(resolvePackageManagerCommand(forcedPm))) {
      return rememberDetection(forcedPm, 'forced-env');
    }
  }

  // First prefer the package manager that demonstrably owns the current install.
  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  if (installPathPm && packageManagerOwnsCurrentInstall(installPathPm)) {
    return rememberDetection(installPathPm, 'install-path-owner');
  }

  const ownershipCandidates = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    if (packageManagerOwnsCurrentInstall(candidate)) {
      return rememberDetection(candidate, 'global-root-owner');
    }
  }

  // Fall back to weaker hints only when ownership cannot be established.
  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  // Check execpath.
  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  // Detect from invoked binary path.
  const invokedPm = detectPackageManagerFromInvocationPath(process.argv?.[1]);
  if (!hintedPm) {
    hintedPm = invokedPm;
  }

  if (!hintedPm) {
    hintedPm = installPathPm;
  }

  // Validate the hint against package visibility, but only after ownership checks failed.
  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm)) && isPackageInstalledWith(hintedPm)) {
    return rememberDetection(hintedPm, 'hinted-visible-install');
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm)) && isPackageInstalledWith(runtimePm)) {
    return rememberDetection(runtimePm, 'runtime-visible-install');
  }

  // Last resort: pick a PM that can at least see the package.
  const pmChecks = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm')) },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn')) },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun')) },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm')) },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      // Verify this PM actually has the package installed globally
      if (isPackageInstalledWith(name)) {
        return rememberDetection(name, 'last-resort-visible-install');
      }
    }
  }

  // npm is only a guess from here on. A copy outside any node_modules folder
  // (an unpacked tarball, the Docker image, a source checkout) was installed
  // by no package manager at all, so no install command updates it.
  return rememberDetection('npm', installPathPm ? 'default-fallback' : 'unmanaged-install');
}

/** The running copy was installed by no package manager, so it cannot update itself. */
export function isUnmanagedInstall() {
  return (cachedDetection ?? detectPackageManagerDetails()).reason === 'unmanaged-install';
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

function detectPackageManagerFromInstallPath(pkgPath) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/') || normalized.includes('/pnpm-store/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/bun/install/')) return 'bun';
  if (normalized.includes('/node_modules/')) return 'npm';
  return null;
}

function detectPackageManagerFromRuntimePath(runtimePath) {
  if (!runtimePath || typeof runtimePath !== 'string') return null;
  const normalized = runtimePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/bun') || normalized.endsWith('/bun') || normalized.endsWith('/bun.exe')) {
    return 'bun';
  }
  if (normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/yarn/')) return 'yarn';
  if (normalized.includes('/node') || normalized.endsWith('/node.exe')) return 'npm';
  return null;
}

function detectPackageManagerFromInvocationPath(invokedPath) {
  if (!invokedPath || typeof invokedPath !== 'string') return null;
  const normalized = invokedPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.bun/bin/')) return 'bun';
  if (normalized.includes('/.pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/')) return 'yarn';
  return null;
}

function getPackageManagerCommandCandidates(pm) {
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

function resolvePackageManagerCommand(pm) {
  const candidates = getPackageManagerCommandCandidates(pm);
  for (const candidate of candidates) {
    if (isCommandAvailable(candidate)) {
      return candidate;
    }
  }
  return pm;
}

function quoteCommand(command) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command) {
  try {
    const result = spawnSync(command, ['--version'], {
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

function getGlobalListArgs(pm) {
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

function isPackageInstalledWith(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const args = getGlobalListArgs(pm);

    const result = spawnSync(pmCommand, args, {
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

// npm, bun and yarn print `name@version`; pnpm separates the name and the
// version with whitespace. An optional `v` covers yarn listing formats.
const GLOBAL_VERSION_PATTERN = /@openchamber\/web[@\s]+v?(\d[\w.+-]*)/;

/**
 * Read the globally installed version of the package as reported by the
 * package manager itself. Returns null when the listing cannot be read or
 * parsed. The listing command may exit non-zero when the package is missing,
 * so stdout is parsed regardless of the status.
 */
function getInstalledGlobalVersion(pm) {
  try {
    const pmCommand = resolvePackageManagerCommand(pm);
    const result = spawnSync(pmCommand, getGlobalListArgs(pm), {
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

/**
 * Normalize a version string into an exact install target.
 * Returns the plain version or null when the value is not a concrete version.
 */
function normalizeTargetVersion(value) {
  const normalized = String(value ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

// Dependencies whose install scripts pnpm 10+ blocks until approved. pnpm 11+
// stops a global install in a terminal to ask about them. Keep in sync with
// scripts/install.sh and with the "Ignored build scripts" list a fresh
// `pnpm add -g @openchamber/web` prints.
const PNPM_BUILD_DEPENDENCIES = ['msgpackr-extract', 'node-pty'];
// First pnpm release that accepts `--allow-build`; older ones reject it as an
// unknown option, and pnpm 9 and older run build scripts without approval.
const PNPM_ALLOW_BUILD_MIN_VERSION = '10.4.0';

function getPnpmAllowBuildFlags(pmCommand) {
  const version = normalizeTargetVersion(getCommandOutput(pmCommand, ['--version']));
  if (!version || compareVersions(version, PNPM_ALLOW_BUILD_MIN_VERSION) < 0) return '';
  return PNPM_BUILD_DEPENDENCIES.map((name) => ` --allow-build=${name}`).join('');
}

/**
 * Get the update command for the detected package manager.
 * When an exact target version is given, it is pinned in the spec instead of
 * re-resolving the `latest` dist-tag at install time: the update check and the
 * package manager see different metadata, and dist-tag resolution can lag the
 * check behind a fresh release (stale packument cache, pnpm minimumReleaseAge).
 */
export function getUpdateCommand(pm = detectPackageManager(), options = {}) {
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

/**
 * Get current installed version from package.json
 */
export function getCurrentVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const UPDATE_CHANNELS = new Set(['stable', 'canary']);

/** A nightly Canary build: 2.5.4-canary.20261030.123. */
const isCanaryVersion = (version) => /-canary\./.test(String(version || ''));

function getSettingsFilePath() {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR?.trim();
  return path.join(dataDir ? path.resolve(dataDir) : path.join(os.homedir(), '.config', 'openchamber'), 'settings.json');
}

/**
 * The channel this install takes its updates from: the one picked in
 * Settings → About (`serverUpdateChannel`). Without a pick, a Canary build
 * (installed with `npm i -g @openchamber/web@canary`) follows Canary, so its
 * first check does not offer the release as a way back nobody asked for.
 */
export function readUpdateChannel(currentVersion = getCurrentVersion()) {
  try {
    const settings = JSON.parse(fs.readFileSync(getSettingsFilePath(), 'utf8'));
    if (UPDATE_CHANNELS.has(settings?.serverUpdateChannel)) return settings.serverUpdateChannel;
  } catch {
  }
  return isCanaryVersion(currentVersion) ? 'canary' : 'stable';
}

/**
 * The package's npm dist-tags (`latest`, and `canary` once the nightly
 * published one), or null when the registry could not be read.
 */
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

    const data = await response.json();
    return data?.['dist-tags'] ?? {};
  } catch (error) {
    return null;
  }
}

/**
 * Fetch latest version from npm registry
 */
async function getLatestVersion() {
  return (await fetchDistTags())?.latest || null;
}

/** Release notes between the installed and the offered version, or undefined. */
async function fetchChangelogNotes(fromVersion, toVersion) {
  return (await fetchUpdateNotes(fromVersion, toVersion, compareVersions)) ?? undefined;
}

/**
 * Canary, and the way back from it. The target is what the channel's npm
 * dist-tag points at; Stable from a Canary build offers the release even
 * though it is older. The website still gets the check-in, so usage counts
 * include it, but its answer is about releases only.
 */
async function checkChannelForUpdates(channel, currentVersion, options) {
  const [, distTags] = await Promise.all([
    checkForUpdatesFromApi(currentVersion, options),
    fetchDistTags(),
  ]);
  if (!distTags) {
    return { available: false, currentVersion, error: 'Unable to determine versions' };
  }
  const target = normalizeTargetVersion(channel === 'canary' ? distTags.canary : distTags.latest);
  // No Canary published yet: nothing to install, which is not an error.
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

export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();
  const appType = normalizeAppType(options.appType);
  const platform = normalizePlatform(options.platform);

  // The channel belongs to the npm server; the desktop app, VS Code and the
  // phones ask about their own builds.
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

  // The Android app ships only as Canary for now (.github/workflows/canary.yml):
  // its next build is the newest APK in the canary pre-release, also for an
  // APK from an earlier release, whose releases carry no APK any more. iOS
  // updates through TestFlight and needs nothing from here.
  if (appType === 'mobile-capacitor' && platform === 'android' && currentVersion !== 'unknown') {
    const [, canary] = await Promise.all([
      checkForUpdatesFromApi(currentVersion, options),
      fetchCanaryAndroidApk(),
    ]);
    if (!canary) {
      return { available: false, currentVersion, error: 'Unable to determine versions' };
    }
    const available = Boolean(canary.newest) && compareVersions(canary.newest.version, currentVersion) > 0;
    return {
      available,
      version: canary.newest?.version,
      currentVersion,
      body: available ? await fetchChangelogNotes(currentVersion, canary.newest.version) : undefined,
      releaseUrl: `${GITHUB_RELEASES_URL}/tag/canary`,
      downloadUrl: available ? canary.newest.url : undefined,
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
    // Show our CLI command, not raw package manager command
    updateCommand: 'openchamber update',
  };
}

/**
 * Execute the update (used by CLI).
 * When an exact target version is given, the globally installed version is
 * read back after the package manager exits: a zero exit status alone is not
 * proof the target landed (stale dist-tag resolution, pnpm release-age policy),
 * and the caller must not report success without the version matching.
 */
export function executeUpdate(pm = detectPackageManager(), options = {}) {
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
