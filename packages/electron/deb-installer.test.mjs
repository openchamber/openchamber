import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installDebUpdate } from './deb-installer.mjs';

const fixture = ({ installResult, installedState = 'ii \n1.17.2\n', packageVersion = '1.17.2' } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-deb-installer-test-'));
  const artifactPath = path.join(root, 'OpenChamber-1.17.2-linux-amd64.deb');
  fs.writeFileSync(artifactPath, 'deb fixture');
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/dpkg-deb') {
      return {
        status: 0,
        signal: null,
        stdout: `Package: openchamber\nVersion: ${packageVersion}\nArchitecture: amd64\n`,
        stderr: '',
      };
    }
    if (command === '/usr/bin/pkexec') {
      return installResult || { status: 0, signal: null, stdout: '', stderr: '' };
    }
    if (command === '/usr/bin/dpkg-query') {
      return { status: 0, signal: null, stdout: installedState, stderr: '' };
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return {
    root,
    artifactPath,
    calls,
    options: {
      artifactPath,
      expectedVersion: '1.17.2',
      architecture: 'x64',
      getuid: () => 1000,
      resolveCommand: (command) => command === 'bash' ? '/bin/bash' : `/usr/bin/${command}`,
      spawnSync,
    },
  };
};

test('installs a matching deb through pkexec and verifies the configured package state', () => {
  const value = fixture();
  try {
    assert.deepEqual(installDebUpdate(value.options), { status: 'ii', version: '1.17.2' });
    const installCall = value.calls.find(({ command }) => command === '/usr/bin/pkexec');
    assert.ok(installCall);
    assert.equal(installCall.options.shell, false);
    assert.ok(installCall.args.includes(value.artifactPath));
    assert.ok(installCall.args.includes('/usr/bin/dpkg'));
    assert.ok(installCall.args.includes('/usr/bin/dpkg-query'));
    assert.match(installCall.args.join('\n'), /package_status/);
    assert.match(installCall.args.join('\n'), /--configure/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects a signal-terminated privileged installer instead of treating it as success', () => {
  const value = fixture({
    installResult: { status: null, signal: 'SIGTERM', stdout: '', stderr: 'terminated' },
  });
  try {
    assert.throws(() => installDebUpdate(value.options), /interrupted by SIGTERM/);
    assert.equal(value.calls.some(({ command }) => command === '/usr/bin/dpkg-query'), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects an unpacked but unconfigured dpkg state', () => {
  const value = fixture({ installedState: 'iU \n1.17.2\n' });
  try {
    assert.throws(() => installDebUpdate(value.options), /did not finish package configuration.*iU/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects a downloaded deb whose package version does not match the update', () => {
  const value = fixture({ packageVersion: '1.17.1' });
  try {
    assert.throws(() => installDebUpdate(value.options), /version mismatch.*1\.17\.1/);
    assert.equal(value.calls.some(({ command }) => command === '/usr/bin/pkexec'), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
