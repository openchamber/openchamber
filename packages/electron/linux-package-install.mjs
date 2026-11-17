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

// external: https://github.com/electron-userland/electron-builder/tree/v26.0.12/packages/electron-updater Use one package-manager invocation; cancellation must not trigger a second password prompt, and downgrades need explicit flags.
const RPM_INSTALLERS = [
  ['zypper', (file, downgrade) => ['zypper', '--non-interactive', '--no-refresh', 'install', '--allow-unsigned-rpm', '-f', ...(downgrade ? ['--oldpackage'] : []), file]],
  ['dnf', (file, downgrade) => ['dnf', downgrade ? 'downgrade' : 'install', '--nogpgcheck', '-y', file]],
  ['yum', (file, downgrade) => ['yum', downgrade ? 'downgrade' : 'install', '--nogpgcheck', '-y', file]],
  ['rpm', (file, downgrade) => ['rpm', '-Uvh', ...(downgrade ? ['--oldpackage'] : []), '--replacepkgs', '--replacefiles', '--nodeps', file]],
];

export const buildPackageInstallCommand = ({ packageType, file, downgrade = false, hasCommand = isOnPath, isRoot = process.getuid?.() === 0 }) => {
  let command;
  if (packageType === 'deb') {
    command = ['apt', 'install', '-y', '--allow-unauthenticated', '--allow-downgrades', '--allow-change-held-packages', file];
  } else if (packageType === 'rpm') {
    const installer = RPM_INSTALLERS.find(([name]) => hasCommand(name));
    if (!installer) throw new Error('No rpm package manager found (zypper, dnf, yum or rpm).');
    command = installer[1](file, downgrade);
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

export const installLinuxPackage = async ({ packageType, file, downgrade = false, run = execFileAsync }) => {
  if (!file) throw new Error('The downloaded update file is missing.');
  const [command, ...args] = buildPackageInstallCommand({ packageType, file, downgrade });
  await run(command, args);
};
