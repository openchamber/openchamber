import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  detectExecutableArch,
  expectedArch,
  isComplete,
  main,
  platformPath,
  repair,
  resolveElectronPackageDir,
} from './ensure-electron.mjs';

const FAIL_SCRIPT = 'process.exit(1);\n';

function headerBytesForArch(arch) {
  const platform = process.platform;
  if (platform === 'darwin') {
    const cputype = { arm64: 0x0100000c, x64: 0x01000007, ia32: 0x00000007, arm: 0x0000000c }[arch];
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(cputype, 4);
    return buf;
  }
  if (platform === 'linux') {
    const machine = { arm64: 183, x64: 62, ia32: 3, arm: 40 }[arch];
    const buf = Buffer.alloc(20);
    buf[0] = 0x7f;
    buf[1] = 0x45;
    buf[2] = 0x4c;
    buf[3] = 0x46;
    buf.writeUInt16LE(machine, 18);
    return buf;
  }
  if (platform === 'win32') {
    const peOffset = 0x80;
    const machine = { arm64: 0xaa64, x64: 0x8664, ia32: 0x014c }[arch];
    const buf = Buffer.alloc(peOffset + 6);
    buf.write('MZ', 0, 'latin1');
    buf.writeUInt32LE(peOffset, 0x3c);
    buf.write('PE\0\0', peOffset, 'latin1');
    buf.writeUInt16LE(machine, peOffset + 4);
    return buf;
  }
  throw new Error(`unsupported test platform: ${platform}`);
}

function installScriptContent({
  arch = expectedArch(),
  platform = platformPath(),
  version = '41.2.1',
  exitCode = 0,
} = {}) {
  const headerHex = headerBytesForArch(arch).toString('hex');
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const platformPath = ${JSON.stringify(platform)};`,
    `const header = Buffer.from('${headerHex}', 'hex');`,
    "const exe = path.join(__dirname, 'dist', platformPath);",
    'fs.mkdirSync(path.dirname(exe), { recursive: true });',
    `fs.writeFileSync(path.join(__dirname, 'dist', 'version'), ${JSON.stringify(version)});`,
    "fs.writeFileSync(path.join(__dirname, 'path.txt'), platformPath);",
    'fs.writeFileSync(exe, header);',
    `process.exit(${exitCode});`,
  ].join('\n');
}

function makeFixture({
  version = '41.2.1',
  complete = false,
  distVersion,
  arch,
  installScripts = {},
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-ensure-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'electron', version }));
  if (complete) {
    const platform = platformPath();
    fs.mkdirSync(path.join(dir, 'dist', path.dirname(platform)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'version'), distVersion ?? version);
    fs.writeFileSync(path.join(dir, 'path.txt'), platform);
    fs.writeFileSync(path.join(dir, 'dist', platform), headerBytesForArch(arch ?? expectedArch()));
  }
  for (const [name, content] of Object.entries(installScripts)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function withFixture(t, options) {
  const dir = makeFixture(options);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('isComplete accepts a healthy same-version, same-arch install', (t) => {
  const dir = withFixture(t, { complete: true });
  assert.equal(isComplete(dir), true);
});

test('isComplete rejects a missing dist directory', (t) => {
  const dir = withFixture(t);
  assert.equal(isComplete(dir), false);
});

test('isComplete rejects a stale/mismatched version', (t) => {
  const dir = withFixture(t, { complete: true, distVersion: '41.1.0' });
  assert.equal(isComplete(dir), false);
});

test('isComplete rejects a missing path.txt', (t) => {
  const dir = withFixture(t, { complete: true });
  fs.rmSync(path.join(dir, 'path.txt'));
  assert.equal(isComplete(dir), false);
});

test('isComplete rejects a binary of the wrong architecture', (t) => {
  const hostArch = expectedArch();
  const otherArch = hostArch === 'arm64' ? 'x64' : 'arm64';
  const dir = withFixture(t, { complete: true, arch: otherArch });
  assert.equal(isComplete(dir), false);
  // With an expected arch matching the fixture the same install passes.
  assert.equal(isComplete(dir, otherArch), true);
});

test('detectExecutableArch reads the header for both architectures', (t) => {
  const hostArch = expectedArch();
  const otherArch = hostArch === 'arm64' ? 'x64' : 'arm64';

  const hostDir = withFixture(t, { complete: true });
  assert.equal(detectExecutableArch(path.join(hostDir, 'dist', platformPath())), hostArch);

  const otherDir = withFixture(t, { complete: true, arch: otherArch });
  assert.equal(detectExecutableArch(path.join(otherDir, 'dist', platformPath())), otherArch);
});

test('detectExecutableArch returns null for a non-executable file', (t) => {
  const dir = withFixture(t);
  const junk = path.join(dir, 'junk.bin');
  fs.writeFileSync(junk, 'not a binary');
  assert.equal(detectExecutableArch(junk), null);
  assert.equal(detectExecutableArch(path.join(dir, 'missing')), null);
});

test('resolveElectronPackageDir locates the electron package in the monorepo', () => {
  const dir = resolveElectronPackageDir();
  assert.ok(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'electron');
});

test('main returns 0 for a healthy install without attempting repair', async (t) => {
  const dir = withFixture(t, { complete: true, installScripts: { 'install.js': FAIL_SCRIPT } });
  const env = {
    ...process.env,
    OPENCHAMBER_ELECTRON_PKG_DIR: dir,
    OPENCHAMBER_ELECTRON_INSTALL_COMMANDS: '[["node",["install.js"]]]',
  };
  assert.equal(await main([], env), 0);
  // The failing install script never ran: dist was not rewritten.
  assert.equal(fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim(), platformPath());
});

test('main repairs an incomplete install via the injected command', async (t) => {
  const dir = withFixture(t, { installScripts: { 'install.js': installScriptContent() } });
  const env = {
    ...process.env,
    OPENCHAMBER_ELECTRON_PKG_DIR: dir,
    OPENCHAMBER_ELECTRON_INSTALL_COMMANDS: '[["node",["install.js"]]]',
  };
  assert.equal(await main([], env), 0);
  assert.equal(isComplete(dir), true);
});

test('main falls back from a failing first command to a succeeding second', async (t) => {
  const dir = withFixture(t, {
    installScripts: {
      'install-fail.js': FAIL_SCRIPT,
      'install-ok.js': installScriptContent(),
    },
  });
  const env = {
    ...process.env,
    OPENCHAMBER_ELECTRON_PKG_DIR: dir,
    OPENCHAMBER_ELECTRON_INSTALL_COMMANDS:
      '[["bun",["install-fail.js"]],["node",["install-ok.js"]]]',
  };
  assert.equal(await main([], env), 0);
  assert.equal(isComplete(dir), true);
});

test('main returns 1 when every repair command fails', async (t) => {
  const dir = withFixture(t, {
    installScripts: {
      'install-fail-1.js': FAIL_SCRIPT,
      'install-fail-2.js': FAIL_SCRIPT,
    },
  });
  const env = {
    ...process.env,
    OPENCHAMBER_ELECTRON_PKG_DIR: dir,
    OPENCHAMBER_ELECTRON_INSTALL_COMMANDS:
      '[["node",["install-fail-1.js"]],["node",["install-fail-2.js"]]]',
  };
  assert.equal(await main([], env), 1);
});

test('main --best-effort returns 0 when repair is impossible', async (t) => {
  const dir = withFixture(t, { installScripts: { 'install-fail.js': FAIL_SCRIPT } });
  const env = {
    ...process.env,
    OPENCHAMBER_ELECTRON_PKG_DIR: dir,
    OPENCHAMBER_ELECTRON_INSTALL_COMMANDS: '[["node",["install-fail.js"]]]',
  };
  assert.equal(await main(['--best-effort'], env), 0);
});

test('main honors ELECTRON_SKIP_BINARY_DOWNLOAD and skips repair', async (t) => {
  const dir = withFixture(t, { installScripts: { 'install.js': installScriptContent() } });
  const env = {
    ...process.env,
    OPENCHAMBER_ELECTRON_PKG_DIR: dir,
    OPENCHAMBER_ELECTRON_INSTALL_COMMANDS: '[["node",["install.js"]]]',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  };
  assert.equal(await main([], env), 1);
  assert.equal(fs.existsSync(path.join(dir, 'dist')), false);

  assert.equal(await main(['--best-effort'], env), 0);
  assert.equal(fs.existsSync(path.join(dir, 'dist')), false);
});

test('main reports a missing electron package', async () => {
  const env = {
    ...process.env,
    OPENCHAMBER_ELECTRON_PKG_DIR: path.join(os.tmpdir(), 'does-not-exist-electron-pkg'),
  };
  assert.equal(await main([], env), 1);
  assert.equal(await main(['--best-effort'], env), 0);
});

test('repair skips a command whose runner errors and keeps trying the rest', (t) => {
  const dir = withFixture(t);
  const calls = [];
  const commands = [['bun', ['install.js']], ['node', ['install.js']]];
  const result = repair(dir, {
    runner: (bin, args) => {
      calls.push([bin, args]);
      return { error: new Error('spawn failed') };
    },
    commands,
  });
  assert.equal(result, false);
  // Exactly the injected commands were invoked, in order.
  assert.deepEqual(calls, commands);
});

test('repair returns false when the runner reports a failure status for every command', (t) => {
  const dir = withFixture(t);
  const calls = [];
  const commands = [['bun', ['install.js']], ['node', ['install.js']]];
  const result = repair(dir, {
    runner: (bin, args) => {
      calls.push([bin, args]);
      return { status: 1 };
    },
    commands,
  });
  assert.equal(result, false);
  assert.deepEqual(calls, commands);
});

test('repair runs injected commands in order and stops after the first success', (t) => {
  const dir = withFixture(t);
  const calls = [];
  const commands = [
    ['bun', ['install-fail.js']],
    ['node', ['install-ok.js']],
    ['node', ['install-never.js']],
  ];
  const result = repair(dir, {
    runner: (bin, args) => {
      calls.push([bin, args]);
      if (args[0] === 'install-ok.js') {
        // Simulate a successful postinstall: materialize a complete install so
        // isComplete() sees a healthy dist right after the command.
        const platform = platformPath();
        fs.mkdirSync(path.join(dir, 'dist', path.dirname(platform)), { recursive: true });
        fs.writeFileSync(path.join(dir, 'dist', 'version'), '41.2.1');
        fs.writeFileSync(path.join(dir, 'path.txt'), platform);
        fs.writeFileSync(path.join(dir, 'dist', platform), headerBytesForArch(expectedArch()));
        return { status: 0 };
      }
      return { status: 1 };
    },
    commands,
  });
  assert.equal(result, true);
  // Only the failing and succeeding commands ran; the trailing one was skipped.
  assert.deepEqual(calls, commands.slice(0, 2));
  assert.equal(isComplete(dir), true);
});
