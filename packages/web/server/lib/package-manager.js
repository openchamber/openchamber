import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = '@openchamber/web';
const PACKAGE_PATH_SEGMENTS = PACKAGE_NAME.split('/');
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const CHANGELOG_URL = 'https://raw.githubusercontent.com/btriapitsyn/openchamber/main/CHANGELOG.md';
const GITHUB_RELEASES_URL = 'https://github.com/openchamber/openchamber/releases';
let cachedDetectedPm = null;
let cachedDetectedPmReason = null;
let cachedDetectedPackagePath = null;

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

async function checkForUpdatesFromApi(currentVersion, options = {}) {
  try {
    const appType = normalizeAppType(options.appType);
    const hostPlatform = mapPlatform(process.platform);
    const hostArch = mapArch(process.arch);
    const shouldTrustClientPlatform = appType === 'vscode' || appType === 'mobile-capacitor';
    const platform = shouldTrustClientPlatform ? normalizePlatform(options.platform) : hostPlatform;
    const arch = shouldTrustClientPlatform ? normalizeArch(options.arch) : hostArch;
    const payload = {
      appType,
      deviceClass: normalizeDeviceClass(options.deviceClass),
      platform,
      arch,
      channel: 'stable',
      currentVersion,
      installId: getOrCreateInstallId(appType),
      instanceMode: options.instanceMode || 'unknown',
      reportUsage: options.reportUsage !== false,
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
    const downloadUrl = typeof data.downloadUrl === 'string'
      ? data.downloadUrl
      : typeof data.download?.url === 'string'
        ? data.download.url
        : undefined;
    return {
      available: Boolean(data.updateAvailable) && versionComparison > 0,
      version: data.latestVersion,
      currentVersion,
      body: typeof data.releaseNotes === 'string' ? data.releaseNotes : undefined,
      releaseUrl: typeof data.releaseNotesUrl === 'string' ? data.releaseNotesUrl : releaseUrl,
      downloadUrl: appType === 'mobile-capacitor' ? (downloadUrl || releaseUrl) : undefined,
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

function getCommandOutput(pm, args) {
  try {
    const launchSpec = getPackageManagerLaunchSpec(pm);
    const result = spawnSync(launchSpec.command, [...launchSpec.argsPrefix, ...args], {
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
  const dirs = [];
  switch (pm) {
    case 'pnpm': {
      const pnpmBin = getCommandOutput(pm, ['bin', '-g']);
      if (pnpmBin) dirs.push(pnpmBin);
      const pnpmPrefix = getCommandOutput(pm, ['prefix', '-g']);
      if (pnpmPrefix) dirs.push(process.platform === 'win32' ? pnpmPrefix : path.join(pnpmPrefix, 'bin'));
      break;
    }
    case 'yarn': {
      const yarnBin = getCommandOutput(pm, ['global', 'bin']);
      if (yarnBin) dirs.push(yarnBin);
      break;
    }
    case 'bun': {
      const bunBin = getCommandOutput(pm, ['pm', 'bin', '-g']);
      if (bunBin) dirs.push(bunBin);
      break;
    }
    default: {
      const npmPrefix = getCommandOutput(pm, ['prefix', '-g']);
      if (npmPrefix) dirs.push(process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin'));
      break;
    }
  }

  return getUniquePaths(dirs);
}

function getGlobalNodeModulesRoots(pm) {
  try {
    const roots = [];

    switch (pm) {
      case 'pnpm': {
        const pnpmRoot = getCommandOutput(pm, ['root', '-g']);
        if (pnpmRoot) roots.push(pnpmRoot);
        const pnpmPrefix = getCommandOutput(pm, ['prefix', '-g']);
        if (pnpmPrefix) roots.push(process.platform === 'win32' ? path.join(pnpmPrefix, 'node_modules') : path.join(pnpmPrefix, 'lib', 'node_modules'));
        break;
      }
      case 'yarn': {
        const yarnDir = getCommandOutput(pm, ['global', 'dir']);
        if (yarnDir) roots.push(path.join(yarnDir, 'node_modules'));
        break;
      }
      case 'bun': {
        const bunBinDir = getCommandOutput(pm, ['pm', 'bin', '-g']);
        if (bunBinDir) {
          roots.push(path.resolve(bunBinDir, '..', 'install', 'global', 'node_modules'));
          roots.push(path.resolve(bunBinDir, '..', '..', 'node_modules'));
        }
        break;
      }
      default:
      {
        const npmRoot = getCommandOutput(pm, ['root', '-g']);
        if (npmRoot) roots.push(npmRoot);
        const npmPrefix = getCommandOutput(pm, ['prefix', '-g']);
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

function findPackageManagerOwnedInstallPath(pm) {
  const currentPackagePaths = getComparablePaths(getCurrentPackagePath());
  const candidatePackagePaths = [
    ...getGlobalNodeModulesRoots(pm).map(getPackagePathForGlobalRoot),
    ...getOwnedPackagePathsFromGlobalBins(pm),
  ];

  for (const candidatePath of candidatePackagePaths) {
    if (!candidatePath) continue;
    if (pathSetContains(currentPackagePaths, getComparablePaths(candidatePath))) {
      return path.resolve(candidatePath);
    }
  }

  return null;
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

  if (cachedDetectedPm) {
      return {
        packageManager: cachedDetectedPm,
        reason: cachedDetectedPmReason || 'cached',
        packagePath: cachedDetectedPackagePath || getCurrentPackagePath(),
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
  }

  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && ['npm', 'pnpm', 'yarn', 'bun'].includes(forcedPm)) {
    const forcedPmCommand = resolvePackageManagerCommand(forcedPm);
    const ownedPackagePath = findPackageManagerOwnedInstallPath(forcedPm);
    if (ownedPackagePath && isCommandAvailable(forcedPmCommand, forcedPm)) {
      cachedDetectedPm = forcedPm;
      cachedDetectedPmReason = 'forced-env-owner';
      cachedDetectedPackagePath = ownedPackagePath;
      return {
        packageManager: cachedDetectedPm,
        reason: cachedDetectedPmReason,
        packagePath: cachedDetectedPackagePath,
        packageManagerCommand: forcedPmCommand,
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
    }
  }

  // First prefer the package manager that demonstrably owns the current install.
  const installPathPm = detectPackageManagerFromCurrentInstallPath();
  const installPathOwnedPackage = installPathPm ? findPackageManagerOwnedInstallPath(installPathPm) : null;
  if (installPathPm && installPathOwnedPackage) {
    cachedDetectedPm = installPathPm;
    cachedDetectedPmReason = 'install-path-owner';
    cachedDetectedPackagePath = installPathOwnedPackage;
    return {
      packageManager: cachedDetectedPm,
      reason: cachedDetectedPmReason,
      packagePath: cachedDetectedPackagePath,
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const ownershipCandidates = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const candidate of ownershipCandidates) {
    const ownedPackagePath = findPackageManagerOwnedInstallPath(candidate);
    if (ownedPackagePath) {
      cachedDetectedPm = candidate;
      cachedDetectedPmReason = 'global-root-owner';
      cachedDetectedPackagePath = ownedPackagePath;
      return {
        packageManager: cachedDetectedPm,
        reason: cachedDetectedPmReason,
        packagePath: cachedDetectedPackagePath,
        packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
        globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
      };
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
  if (hintedPm && isCommandAvailable(resolvePackageManagerCommand(hintedPm), hintedPm) && isPackageInstalledWith(hintedPm)) {
    cachedDetectedPm = hintedPm;
    cachedDetectedPmReason = 'hinted-visible-install';
    cachedDetectedPackagePath = getCurrentPackagePath();
    return {
      packageManager: cachedDetectedPm,
      reason: cachedDetectedPmReason,
      packagePath: cachedDetectedPackagePath,
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  const runtimePm = detectPackageManagerFromRuntimePath(process.execPath);
  if (runtimePm && isCommandAvailable(resolvePackageManagerCommand(runtimePm), runtimePm) && isPackageInstalledWith(runtimePm)) {
    cachedDetectedPm = runtimePm;
    cachedDetectedPmReason = 'runtime-visible-install';
    cachedDetectedPackagePath = getCurrentPackagePath();
    return {
      packageManager: cachedDetectedPm,
      reason: cachedDetectedPmReason,
      packagePath: cachedDetectedPackagePath,
      packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
      globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
    };
  }

  // Last resort: pick a PM that can at least see the package.
  const pmChecks = [
    { name: 'pnpm', check: () => isCommandAvailable(resolvePackageManagerCommand('pnpm'), 'pnpm') },
    { name: 'yarn', check: () => isCommandAvailable(resolvePackageManagerCommand('yarn'), 'yarn') },
    { name: 'bun', check: () => isCommandAvailable(resolvePackageManagerCommand('bun'), 'bun') },
    { name: 'npm', check: () => isCommandAvailable(resolvePackageManagerCommand('npm'), 'npm') },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      // Verify this PM actually has the package installed globally
      if (isPackageInstalledWith(name)) {
        cachedDetectedPm = name;
        cachedDetectedPmReason = 'last-resort-visible-install';
        cachedDetectedPackagePath = getCurrentPackagePath();
        return {
          packageManager: cachedDetectedPm,
          reason: cachedDetectedPmReason,
          packagePath: cachedDetectedPackagePath,
          packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
          globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
        };
      }
    }
  }

  cachedDetectedPm = 'npm';
  cachedDetectedPmReason = 'default-fallback';
  cachedDetectedPackagePath = getCurrentPackagePath();
  return {
    packageManager: cachedDetectedPm,
    reason: cachedDetectedPmReason,
    packagePath: cachedDetectedPackagePath,
    packageManagerCommand: resolvePackageManagerCommand(cachedDetectedPm),
    globalNodeModulesRoot: getGlobalNodeModulesRoots(cachedDetectedPm)[0] || null,
  };
}

export function detectPackageManager() {
  return detectPackageManagerDetails().packageManager;
}

function detectPackageManagerFromInstallPath(pkgPath) {
  if (!pkgPath) return null;
  const normalized = pkgPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/')) return 'pnpm';
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
    if (isCommandAvailable(candidate, pm)) {
      return candidate;
    }
  }
  return pm;
}

function getPackageManagerUpdateArgs(pm, targetVersion = 'latest') {
  if (targetVersion !== 'latest' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
    throw new Error(`Invalid OpenChamber update target version: ${targetVersion}`);
  }
  const packageSpec = `${PACKAGE_NAME}@${targetVersion}`;
  switch (pm) {
    case 'pnpm':
      return ['add', '-g', packageSpec];
    case 'yarn':
      return ['global', 'add', packageSpec];
    case 'bun':
      return ['add', '-g', packageSpec];
    default:
      return ['install', '-g', packageSpec];
  }
}

function resolveWindowsCommandPath(command, spawnSyncImpl = spawnSync) {
  if (path.isAbsolute(command) && fs.existsSync(command)) {
    return command;
  }

  try {
    const result = spawnSyncImpl('where.exe', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const matches = String(result.stdout || '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return matches.find((value) => ['.exe', '.cmd', '.bat', '.com'].includes(path.extname(value).toLowerCase()))
      || matches[0]
      || null;
  } catch {
    return null;
  }
}

function resolveWindowsPackageManagerShim(commandPath, pm, execPath = process.execPath) {
  const extension = path.extname(commandPath).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') {
    return { command: commandPath, argsPrefix: [], source: 'executable' };
  }

  const shimDirectory = path.dirname(commandPath);
  const relativeCandidates = {
    npm: [
      ['node_modules', 'npm', 'bin', 'npm-cli.js'],
    ],
    pnpm: [
      ['node_modules', 'pnpm', 'bin', 'pnpm.cjs'],
      ['node_modules', 'corepack', 'dist', 'pnpm.js'],
    ],
    yarn: [
      ['node_modules', 'yarn', 'bin', 'yarn.js'],
      ['node_modules', 'corepack', 'dist', 'yarn.js'],
    ],
  };
  const scriptPath = (relativeCandidates[pm] || [])
    .map((segments) => path.join(shimDirectory, ...segments))
    .find((candidate) => fs.existsSync(candidate));
  if (!scriptPath) {
    throw new Error(`Unable to safely resolve the ${pm} Windows command shim: ${commandPath}`);
  }

  const adjacentNode = path.join(shimDirectory, 'node.exe');
  const nodeCommand = fs.existsSync(adjacentNode) ? adjacentNode : execPath;
  return {
    command: nodeCommand,
    argsPrefix: [scriptPath],
    source: 'node-shim',
  };
}

export function getPackageManagerLaunchSpec(pm = detectPackageManager(), options = {}) {
  const platform = options.platform || process.platform;
  const packageManagerCommand = options.command || resolvePackageManagerCommand(pm);

  if (platform !== 'win32' || pm === 'bun') {
    return {
      command: packageManagerCommand,
      argsPrefix: [],
      source: 'executable',
    };
  }

  const commandPath = resolveWindowsCommandPath(packageManagerCommand, options.spawnSync || spawnSync);
  if (!commandPath) {
    throw new Error(`Unable to resolve the ${pm} executable on Windows`);
  }
  const resolved = resolveWindowsPackageManagerShim(commandPath, pm, options.execPath || process.execPath);
  return {
    command: resolved.command,
    argsPrefix: resolved.argsPrefix,
    source: resolved.source,
  };
}

export function getUpdateLaunchSpec(pm = detectPackageManager(), targetVersion = 'latest', options = {}) {
  const launchSpec = getPackageManagerLaunchSpec(pm, options);
  return {
    command: launchSpec.command,
    args: [...launchSpec.argsPrefix, ...getPackageManagerUpdateArgs(pm, targetVersion)],
    source: launchSpec.source,
  };
}

function quoteCommand(command) {
  if (!command) return command;
  if (!/\s/.test(command)) return command;
  if (process.platform === 'win32') {
    return `"${command.replace(/"/g, '""')}"`;
  }
  return `'${command.replace(/'/g, "'\\''")}'`;
}

function isCommandAvailable(command, pm) {
  try {
    let executable = command;
    let args = ['--version'];
    if (process.platform === 'win32' && pm) {
      const commandPath = resolveWindowsCommandPath(command);
      if (!commandPath) return false;
      const launchSpec = resolveWindowsPackageManagerShim(commandPath, pm, process.execPath);
      executable = launchSpec.command;
      args = [...launchSpec.argsPrefix, '--version'];
    }
    const result = spawnSync(executable, args, {
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

function isPackageInstalledWith(pm) {
  try {
    const launchSpec = getPackageManagerLaunchSpec(pm);
    let args;
    switch (pm) {
      case 'pnpm':
        args = ['list', '-g', '--depth=0', PACKAGE_NAME];
        break;
      case 'yarn':
        args = ['global', 'list', '--depth=0'];
        break;
      case 'bun':
        args = ['pm', 'ls', '-g'];
        break;
      default:
        args = ['list', '-g', '--depth=0', PACKAGE_NAME];
    }

    const result = spawnSync(launchSpec.command, [...launchSpec.argsPrefix, ...args], {
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

/**
 * Get the update command for the detected package manager
 */
export function getUpdateCommand(pm = detectPackageManager(), targetVersion = 'latest') {
  const pmCommand = quoteCommand(resolvePackageManagerCommand(pm));
  return [pmCommand, ...getPackageManagerUpdateArgs(pm, targetVersion)].join(' ');
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

/**
 * Fetch latest version from npm registry
 */
async function getLatestVersion() {
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}`);
    }

    const data = await response.json();
    return data['dist-tags']?.latest || null;
  } catch (error) {
    return null;
  }
}

/**
 * Compare semver-like version strings.
 */
function parseVersionForComparison(value) {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const parts = core.split('.').map((part) => {
    const parsed = Number.parseInt(part || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });

  return {
    parts,
    prerelease: prereleaseIndex >= 0,
  };
}

function compareVersions(left, right) {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }

  if (a.prerelease !== b.prerelease) {
    return a.prerelease ? -1 : 1;
  }

  return 0;
}

/**
 * Fetch changelog notes between versions
 */
async function fetchChangelogNotes(fromVersion, toVersion) {
  try {
    const response = await fetch(CHANGELOG_URL, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return undefined;

    const changelog = await response.text();
    const sections = changelog.split(/^## /m).slice(1);

    const relevantSections = sections.filter((section) => {
      const match = section.match(/^\[(\d+\.\d+\.\d+)\]/);
      if (!match) return false;
      return compareVersions(match[1], fromVersion) > 0 && compareVersions(match[1], toVersion) <= 0;
    });

    if (relevantSections.length === 0) return undefined;

    return relevantSections
      .map((s) => '## ' + s.trim())
      .join('\n\n');
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(options = {}) {
  const currentVersion = options.currentVersion || getCurrentVersion();
  const pm = detectPackageManager();
  const appType = normalizeAppType(options.appType);
  const platform = normalizePlatform(options.platform);

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
  let changelog;
  if (available) {
    changelog = await fetchChangelogNotes(currentVersion, latestVersion);
  }

  return {
    available,
    version: latestVersion,
    currentVersion,
    body: changelog,
    releaseUrl: `${GITHUB_RELEASES_URL}/tag/v${latestVersion}`,
    downloadUrl: appType === 'mobile-capacitor' && platform === 'android' ? `${GITHUB_RELEASES_URL}/tag/v${latestVersion}` : undefined,
    packageManager: pm,
    // Show our CLI command, not raw package manager command
    updateCommand: 'openchamber update',
  };
}

/**
 * Execute the update (used by CLI)
 */
export function executeUpdate(pm = detectPackageManager(), options = {}) {
  const targetVersion = options.targetVersion || 'latest';
  const command = getUpdateCommand(pm, targetVersion);
  const launchSpec = getUpdateLaunchSpec(pm, targetVersion);
  if (!options?.silent) {
    console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
    console.log(`Running: ${command}`);
  }

  const result = spawnSync(launchSpec.command, launchSpec.args, {
    stdio: 'inherit',
    ...getSpawnSyncBaseOptions(),
  });

  return {
    success: result.status === 0,
    exitCode: result.status,
  };
}
