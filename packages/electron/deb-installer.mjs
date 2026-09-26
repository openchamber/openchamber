import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';

const PACKAGE_NAME = 'openchamber';
const INSTALL_SCRIPT = [
  'set -eu',
  'artifact_path="$1"',
  'dpkg_path="$2"',
  'apt_get_path="$3"',
  'dpkg_query_path="$4"',
  'package_name="$5"',
  // dpkg can leave a package unpacked when configuration is interrupted. Always run
  // the configure phase explicitly, and use apt only to repair dependency failures.
  'if ! "$dpkg_path" -i -- "$artifact_path"; then',
  '  "$apt_get_path" install -f -y',
  '  "$dpkg_path" -i -- "$artifact_path"',
  'fi',
  // A successful dpkg -i normally configures the package itself. Only run the explicit
  // recovery step when dpkg still reports an unpacked/half-configured state; configuring
  // an already configured package returns exit code 1 on supported Debian/Ubuntu versions.
  'package_status="$("$dpkg_query_path" -W -f=\'${db:Status-Abbrev}\' "$package_name" 2>/dev/null || true)"',
  'case "$package_status" in',
  '  ii*) ;;',
  '  *) "$dpkg_path" --configure "$package_name" ;;',
  'esac',
].join('\n');

const expectedDebArchitecture = (architecture) => {
  if (architecture === 'x64') return 'amd64';
  if (architecture === 'arm64') return 'arm64';
  throw new Error(`Deb updates are not supported on architecture: ${architecture}`);
};

const resolveCommandFromPath = (command, environment = process.env) => {
  for (const directory of String(environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
};

const commandFailureDetail = (result) => {
  const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
  return stderr ? `: ${stderr.slice(-2000)}` : '';
};

const assertCommandSucceeded = (result, label) => {
  if (result?.error) {
    throw new Error(`${label} could not start: ${result.error.message || result.error}`);
  }
  // Node reports a signal-terminated child with status=null. electron-updater 6.8.3
  // ignores this case, which can treat an interrupted dpkg unpack as a successful install.
  if (result?.signal) {
    throw new Error(`${label} was interrupted by ${result.signal}${commandFailureDetail(result)}`);
  }
  if (!Number.isInteger(result?.status) || result.status !== 0) {
    throw new Error(`${label} exited with code ${result?.status ?? 'unknown'}${commandFailureDetail(result)}`);
  }
};

const parseDebFields = (stdout) => {
  const fields = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) fields.set(match[1], match[2].trim());
  }
  return fields;
};

const readInstalledPackageState = ({ dpkgQueryPath, spawnSync }) => {
  const result = spawnSync(dpkgQueryPath, [
    '-W',
    '-f=${db:Status-Abbrev}\n${Version}\n',
    PACKAGE_NAME,
  ], {
    encoding: 'utf8',
    shell: false,
  });
  assertCommandSucceeded(result, 'Installed deb verification');
  const [status = '', version = ''] = String(result.stdout || '').split(/\r?\n/);
  return { status: status.trim(), version: version.trim() };
};

/**
 * Installs an electron-updater-downloaded OpenChamber deb and verifies the final dpkg state.
 *
 * The artifact must already have passed electron-updater's manifest checksum validation.
 * This function additionally validates package identity, version, and architecture before
 * elevation. It throws on cancellation, signal termination, incomplete configuration, or
 * version mismatch, and only returns after dpkg reports a fully installed package.
 */
export const installDebUpdate = (options) => {
  const {
    artifactPath,
    expectedVersion,
    architecture = process.arch,
    environment = process.env,
    getuid = process.getuid?.bind(process),
    resolveCommand = (command) => resolveCommandFromPath(command, environment),
    spawnSync = nodeSpawnSync,
  } = options;
  if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath) || path.extname(artifactPath) !== '.deb') {
    throw new Error('Downloaded deb update must be an absolute .deb file path');
  }
  if (typeof expectedVersion !== 'string' || !expectedVersion.trim()) {
    throw new Error('Downloaded deb update is missing its expected version');
  }
  let artifactStat;
  try {
    artifactStat = fs.statSync(artifactPath);
  } catch {
    throw new Error(`Downloaded deb update cannot be found: ${artifactPath}`);
  }
  if (!artifactStat.isFile()) {
    throw new Error(`Downloaded deb update is not a file: ${artifactPath}`);
  }

  const dpkgDebPath = resolveCommand('dpkg-deb');
  const dpkgPath = resolveCommand('dpkg');
  const dpkgQueryPath = resolveCommand('dpkg-query');
  const aptGetPath = resolveCommand('apt-get');
  const bashPath = resolveCommand('bash');
  if (!dpkgDebPath || !dpkgPath || !dpkgQueryPath || !aptGetPath || !bashPath) {
    throw new Error('Deb updates require bash, dpkg, dpkg-deb, dpkg-query, and apt-get');
  }

  const inspectResult = spawnSync(dpkgDebPath, [
    '--field',
    artifactPath,
    'Package',
    'Version',
    'Architecture',
  ], {
    encoding: 'utf8',
    shell: false,
  });
  assertCommandSucceeded(inspectResult, 'Downloaded deb inspection');
  const fields = parseDebFields(inspectResult.stdout);
  if (fields.get('Package') !== PACKAGE_NAME) {
    throw new Error(`Downloaded deb package mismatch: expected ${PACKAGE_NAME}, got ${fields.get('Package') || '(missing)'}`);
  }
  if (fields.get('Version') !== expectedVersion) {
    throw new Error(`Downloaded deb version mismatch: expected ${expectedVersion}, got ${fields.get('Version') || '(missing)'}`);
  }
  const expectedArchitecture = expectedDebArchitecture(architecture);
  if (fields.get('Architecture') !== expectedArchitecture) {
    throw new Error(
      `Downloaded deb architecture mismatch: expected ${expectedArchitecture}, got ${fields.get('Architecture') || '(missing)'}`,
    );
  }

  const installArgs = [
    '-c',
    INSTALL_SCRIPT,
    'openchamber-deb-installer',
    artifactPath,
    dpkgPath,
    aptGetPath,
    dpkgQueryPath,
    PACKAGE_NAME,
  ];
  let installCommand = bashPath;
  if (typeof getuid !== 'function' || getuid() !== 0) {
    const pkexecPath = resolveCommand('pkexec');
    const sudoPath = resolveCommand('sudo');
    if (pkexecPath) {
      installCommand = pkexecPath;
      installArgs.unshift('--disable-internal-agent', bashPath);
    } else if (sudoPath) {
      installCommand = sudoPath;
      installArgs.unshift(bashPath);
    } else {
      throw new Error('Deb updates require pkexec or sudo to request administrator privileges');
    }
  }

  const installResult = spawnSync(installCommand, installArgs, {
    encoding: 'utf8',
    shell: false,
    timeout: 5 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assertCommandSucceeded(installResult, 'Deb update installation');

  const installed = readInstalledPackageState({ dpkgQueryPath, spawnSync });
  if (installed.status !== 'ii') {
    throw new Error(`Deb update did not finish package configuration: dpkg status is ${installed.status || '(missing)'}`);
  }
  if (installed.version !== expectedVersion) {
    throw new Error(`Installed deb version mismatch: expected ${expectedVersion}, got ${installed.version || '(missing)'}`);
  }
  return installed;
};
