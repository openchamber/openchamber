import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isOnPath = (name, pathEnv = process.env.PATH) => (pathEnv || '').split(':').some((dir) => {
  if (!dir) return false;
  try {
    fs.accessSync(path.join(dir, name), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

// The same commands electron-updater 6.8 runs for .deb and .rpm, as one call
// each: its dpkg path retries a failed install with `apt-get install -f`,
// which asks for the password a second time after a cancel.
const RPM_INSTALLERS = [
  ['zypper', (file) => ['zypper', '--non-interactive', '--no-refresh', 'install', '--allow-unsigned-rpm', '-f', file]],
  ['dnf', (file) => ['dnf', 'install', '--nogpgcheck', '-y', file]],
  ['yum', (file) => ['yum', 'install', '--nogpgcheck', '-y', file]],
  ['rpm', (file) => ['rpm', '-Uvh', '--replacepkgs', '--replacefiles', '--nodeps', file]],
];

export const buildPackageInstallCommand = ({ packageType, file, hasCommand = isOnPath, isRoot = process.getuid?.() === 0 }) => {
  let command;
  if (packageType === 'deb') {
    command = ['apt', 'install', '-y', '--allow-unauthenticated', '--allow-downgrades', '--allow-change-held-packages', file];
  } else if (packageType === 'rpm') {
    const installer = RPM_INSTALLERS.find(([name]) => hasCommand(name));
    if (!installer) throw new Error('No rpm package manager found (zypper, dnf, yum or rpm).');
    command = installer[1](file);
  } else {
    throw new Error(`Unsupported Linux package type: ${packageType}`);
  }
  return isRoot ? command : ['pkexec', '--disable-internal-agent', ...command];
};

const execFileAsync = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(`${file} exited with code ${error.code}: ${String(stderr).trim().slice(-2000)}`));
    } else {
      resolve(stdout);
    }
  });
});

/**
 * Installs a downloaded .deb or .rpm without blocking the main process.
 * electron-updater runs the installer with spawnSync, which freezes every
 * window, the update dialog's spinner included, for the whole password prompt
 * and install. Rejects when the user cancels the prompt (pkexec exits 126).
 */
export const installLinuxPackage = async ({ packageType, file, run = execFileAsync }) => {
  if (!file) throw new Error('The downloaded update file is missing.');
  const [command, ...args] = buildPackageInstallCommand({ packageType, file });
  await run(command, args);
};
