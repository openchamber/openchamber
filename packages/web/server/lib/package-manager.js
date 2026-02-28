import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = '@openchamber/web';
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const CHANGELOG_URL = 'https://raw.githubusercontent.com/btriapitsyn/openchamber/main/CHANGELOG.md';

/**
 * Detect which package manager was used to install this package.
 * Strategy:
 * 1. Check npm_config_user_agent (set during npm/pnpm/yarn/bun install)
 * 2. Check npm_execpath for PM binary path
 * 3. Analyze package location path for PM-specific patterns
 * 4. Fall back to npm
 */
export function detectPackageManager() {
  const forcedPm = process.env.OPENCHAMBER_PACKAGE_MANAGER?.trim();
  if (forcedPm && ['npm', 'pnpm', 'yarn', 'bun'].includes(forcedPm) && isCommandAvailable(forcedPm)) {
    return forcedPm;
  }

  // Strategy 1: Check user agent (most reliable during install)
  const userAgent = process.env.npm_config_user_agent || '';
  let hintedPm = null;
  if (userAgent.startsWith('pnpm')) hintedPm = 'pnpm';
  else if (userAgent.startsWith('yarn')) hintedPm = 'yarn';
  else if (userAgent.startsWith('bun')) hintedPm = 'bun';
  else if (userAgent.startsWith('npm')) hintedPm = 'npm';

  // Strategy 2: Check execpath
  const execPath = process.env.npm_execpath || '';
  if (!hintedPm) {
    if (execPath.includes('pnpm')) hintedPm = 'pnpm';
    else if (execPath.includes('yarn')) hintedPm = 'yarn';
    else if (execPath.includes('bun')) hintedPm = 'bun';
    else if (execPath.includes('npm')) hintedPm = 'npm';
  }

  // Strategy 3: Analyze package location for PM-specific patterns
  try {
    const pkgPath = path.resolve(__dirname, '..', '..');
    const pmFromPath = detectPackageManagerFromInstallPath(pkgPath);
    if (pmFromPath && isCommandAvailable(pmFromPath)) {
      return pmFromPath;
    }
    if (!hintedPm) {
      hintedPm = pmFromPath;
    }
  } catch {
    // Ignore path resolution errors
  }

  // Validate the hinted PM actually owns the global install.
  // This avoids false positives (for example running via bunx while installed with npm).
  if (hintedPm && isCommandAvailable(hintedPm) && isPackageInstalledWith(hintedPm)) {
    return hintedPm;
  }

  // Strategy 4: Check which PM binaries are available and preferred
  const pmChecks = [
    { name: 'pnpm', check: () => isCommandAvailable('pnpm') },
    { name: 'yarn', check: () => isCommandAvailable('yarn') },
    { name: 'bun', check: () => isCommandAvailable('bun') },
    { name: 'npm', check: () => isCommandAvailable('npm') },
  ];

  for (const { name, check } of pmChecks) {
    if (check()) {
      // Verify this PM actually has the package installed globally
      if (isPackageInstalledWith(name)) {
        return name;
      }
    }
  }

  return 'npm';
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

function isCommandAvailable(command) {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function isPackageInstalledWith(pm) {
  try {
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

    const result = spawnSync(pm, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
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
export function getUpdateCommand(pm = detectPackageManager()) {
  switch (pm) {
    case 'pnpm':
      return `pnpm add -g ${PACKAGE_NAME}@latest`;
    case 'yarn':
      return `yarn global add ${PACKAGE_NAME}@latest`;
    case 'bun':
      return `bun add -g ${PACKAGE_NAME}@latest`;
    default:
      return `npm install -g ${PACKAGE_NAME}@latest`;
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

/**
 * Fetch latest version from npm registry
 */
export async function getLatestVersion() {
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
    console.warn('Failed to fetch latest version from npm:', error.message);
    return null;
  }
}

/**
 * Parse semver version to numeric for comparison
 */
function parseVersion(version) {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  return (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

/**
 * Fetch changelog notes between versions
 */
export async function fetchChangelogNotes(fromVersion, toVersion) {
  try {
    const response = await fetch(CHANGELOG_URL, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return undefined;

    const changelog = await response.text();
    const sections = changelog.split(/^## /m).slice(1);

    const fromNum = parseVersion(fromVersion);
    const toNum = parseVersion(toVersion);

    const relevantSections = sections.filter((section) => {
      const match = section.match(/^\[(\d+\.\d+\.\d+)\]/);
      if (!match) return false;
      const ver = parseVersion(match[1]);
      return ver > fromNum && ver <= toNum;
    });

    if (relevantSections.length === 0) return undefined;

    return relevantSections
      .map((s) => '## ' + s.trim())
      .join('\n\n');
  } catch {
    return undefined;
  }
}

/**
 * Check for updates and return update info
 */
export async function checkForUpdates() {
  const currentVersion = getCurrentVersion();
  const latestVersion = await getLatestVersion();

  if (!latestVersion || currentVersion === 'unknown') {
    return {
      available: false,
      currentVersion,
      error: 'Unable to determine versions',
    };
  }

  const currentNum = parseVersion(currentVersion);
  const latestNum = parseVersion(latestVersion);
  const available = latestNum > currentNum;

  const pm = detectPackageManager();

  let changelog;
  if (available) {
    changelog = await fetchChangelogNotes(currentVersion, latestVersion);
  }

  return {
    available,
    version: latestVersion,
    currentVersion,
    body: changelog,
    packageManager: pm,
    // Show our CLI command, not raw package manager command
    updateCommand: 'openchamber update',
  };
}

/**
 * Execute the update (used by CLI)
 */
export function executeUpdate(pm = detectPackageManager()) {
  const command = getUpdateCommand(pm);
  console.log(`Updating ${PACKAGE_NAME} using ${pm}...`);
  console.log(`Running: ${command}`);

  const [cmd, ...args] = command.split(' ');
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: true,
  });

  return {
    success: result.status === 0,
    exitCode: result.status,
  };
}
