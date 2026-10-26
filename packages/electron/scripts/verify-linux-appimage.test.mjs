import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linuxAppImageArchSuffix, readElfArchitecture, verifyExtractedPayload } from './verify-linux-appimage.mjs';

const writeElf = (filePath, architecture) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  fs.writeFileSync(filePath, header, { mode: 0o755 });
};

const writeIcon = (root, relativePath) => {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), 'icon');
  fs.rmSync(path.join(root, '.DirIcon'), { force: true });
  fs.symlinkSync(relativePath, path.join(root, '.DirIcon'));
};

const createPayload = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-payload-test-'));
  fs.writeFileSync(path.join(root, 'openchamber.desktop'), [
    '[Desktop Entry]', 'Name=OpenChamber', 'Exec=AppRun --no-sandbox %U', 'Icon=openchamber', 'StartupWMClass=openchamber', '',
  ].join('\n'));
  writeElf(path.join(root, 'openchamber'), 'x64');
  writeElf(path.join(root, 'resources/opencode-cli/opencode'), 'x64');
  writeElf(path.join(root, 'resources/ripgrep/rg'), 'x64');
  for (const name of ['pty.node', 'sherpa-onnx.node']) {
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules', name), 'x64');
  }
  writeIcon(root, 'usr/share/icons/hicolor/512x512/apps/openchamber.png');
  return root;
};

const verify = (root) => verifyExtractedPayload({
  root,
  targetArchitecture: 'x64',
  expectedOpenCodeVersion: '1.17.18',
  runCliVersion: () => '1.17.18',
});

test('reads supported ELF architectures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-elf-test-'));
  try {
    writeElf(path.join(root, 'x64'), 'x64');
    writeElf(path.join(root, 'arm64'), 'arm64');
    assert.equal(readElfArchitecture(path.join(root, 'x64')), 'x64');
    assert.equal(readElfArchitecture(path.join(root, 'arm64')), 'arm64');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AppImage artifact names use electron-builder arch suffixes', () => {
  assert.equal(linuxAppImageArchSuffix('x64'), 'x86_64');
  assert.equal(linuxAppImageArchSuffix('arm64'), 'arm64');
});

test('verifies identity, version, and native payload architecture', () => {
  const root = createPayload();
  try {
    const result = verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.18',
    });
    assert.equal(result.nativeModuleCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a missing native module', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'));
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.18',
    }), /Missing packaged native module: pty\.node/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on wrong CLI version or native architecture', () => {
  const root = createPayload();
  try {
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.17',
    }), /OpenCode CLI version mismatch/);
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules/pty.node'), 'arm64');
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.18',
    }), /Native module architecture mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts a scalable theme icon', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'usr/share/icons/hicolor/512x512'), { recursive: true });
    writeIcon(root, 'usr/share/icons/hicolor/scalable/apps/openchamber.svg');
    assert.equal(verify(root).nativeModuleCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails when the theme cannot resolve Icon=openchamber', () => {
  for (const relativePath of [
    'usr/share/icons/hicolor/scalable/openchamber.svg',
    'usr/share/icons/hicolor/1024x1024/apps/openchamber.png',
  ]) {
    const root = createPayload();
    try {
      fs.rmSync(path.join(root, 'usr/share/icons/hicolor/512x512'), { recursive: true });
      writeIcon(root, relativePath);
      assert.throws(() => verify(root), /Missing theme icon/, relativePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('fails when .DirIcon is dangling', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, '.DirIcon'));
    fs.symlinkSync('usr/share/icons/hicolor/scalable/openchamber.svg', path.join(root, '.DirIcon'));
    assert.throws(() => verify(root), /\.DirIcon does not resolve/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
