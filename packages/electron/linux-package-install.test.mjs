import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPackageInstallCommand, installLinuxPackage } from './linux-package-install.mjs';

const file = '/home/u/.cache/pending/OpenChamber 2.3.0.deb';

test('a .deb installs with apt in one elevated call', () => {
  assert.deepEqual(buildPackageInstallCommand({ packageType: 'deb', file, isRoot: false }), [
    'pkexec', '--disable-internal-agent',
    'apt', 'install', '-y', '--allow-unauthenticated', '--allow-downgrades', '--allow-change-held-packages', file,
  ]);
});

test('an .rpm uses the first package manager present', () => {
  const present = new Set(['dnf', 'rpm']);
  assert.deepEqual(
    buildPackageInstallCommand({ packageType: 'rpm', file: '/x.rpm', isRoot: true, hasCommand: (name) => present.has(name) }),
    ['dnf', 'install', '--nogpgcheck', '-y', '/x.rpm'],
  );
  assert.throws(
    () => buildPackageInstallCommand({ packageType: 'rpm', file: '/x.rpm', hasCommand: () => false }),
    /No rpm package manager/,
  );
});

test('an .rpm downgrade (Stable after Canary) tells the package manager the older package is wanted', () => {
  const only = (name) => (candidate) => candidate === name;
  const command = (name) => buildPackageInstallCommand({ packageType: 'rpm', file: '/x.rpm', downgrade: true, isRoot: true, hasCommand: only(name) });
  assert.deepEqual(command('dnf'), ['dnf', 'downgrade', '--nogpgcheck', '-y', '/x.rpm']);
  assert.deepEqual(command('yum'), ['yum', 'downgrade', '--nogpgcheck', '-y', '/x.rpm']);
  assert.deepEqual(command('zypper'), ['zypper', '--non-interactive', '--no-refresh', 'install', '--allow-unsigned-rpm', '-f', '--oldpackage', '/x.rpm']);
  assert.deepEqual(command('rpm'), ['rpm', '-Uvh', '--oldpackage', '--replacepkgs', '--replacefiles', '--nodeps', '/x.rpm']);
  // apt already allows downgrades on every install.
  assert.deepEqual(
    buildPackageInstallCommand({ packageType: 'deb', file: '/x.deb', downgrade: true, isRoot: true }),
    buildPackageInstallCommand({ packageType: 'deb', file: '/x.deb', isRoot: true }),
  );
});

test('the install passes the path as one argument and surfaces a cancelled prompt', async () => {
  const calls = [];
  await installLinuxPackage({ packageType: 'deb', file, run: async (command, args) => { calls.push([command, ...args]); } });
  assert.equal(calls[0].at(-1), file);

  await assert.rejects(
    installLinuxPackage({ packageType: 'deb', file, run: async () => { throw new Error('pkexec exited with code 126'); } }),
    /code 126/,
  );
  await assert.rejects(installLinuxPackage({ packageType: 'deb', file: undefined }), /missing/);
});
