import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linuxDebArchSuffix, readDebMembers, verifyDebPayload } from './verify-linux-deb.mjs';

const AR_MAGIC = Buffer.from('!<arch>\n');

const writeArMember = (name, data) => {
  const nameBuf = Buffer.alloc(16);
  nameBuf.write(name.slice(0, 16));
  const fields = Buffer.from(
    '0'.padEnd(12)
      + '0'.padStart(6)
      + '0'.padStart(6)
      + '100644'.padStart(8)
      + String(data.length).padStart(10),
    'latin1',
  );
  const header = Buffer.concat([nameBuf, fields, Buffer.from('`\n')]);
  const parts = [header, data];
  if (data.length % 2) parts.push(Buffer.from('\n'));
  return parts;
};

const writeDeb = (debPath, members) => {
  fs.mkdirSync(path.dirname(debPath), { recursive: true });
  const chunks = [AR_MAGIC];
  for (const member of members) chunks.push(...writeArMember(member.name, member.data));
  fs.writeFileSync(debPath, Buffer.concat(chunks));
};

const writeElf = (filePath, architecture) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  fs.writeFileSync(filePath, header, { mode: 0o755 });
};

// 8-byte PNG signature; the verifier only requires the signature, not a full file.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const writeLauncherIcon = (root) => {
  const iconPath = path.join(root, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps', 'openchamber.png');
  fs.mkdirSync(path.dirname(iconPath), { recursive: true });
  fs.writeFileSync(iconPath, Buffer.concat([PNG_SIGNATURE, Buffer.from('00000000')]));
  return iconPath;
};

// Builds a payload tree rooted at 'opt/OpenChamber' plus the desktop entry,
// which is what deb installs produce after extracting the data archive.
const createPayload = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-deb-payload-'));
  writeElf(path.join(root, 'opt/OpenChamber/openchamber'), 'x64');
  writeElf(path.join(root, 'opt/OpenChamber/resources/opencode-cli/opencode'), 'x64');
  for (const name of ['pty.node', 'sherpa-onnx.node']) {
    writeElf(path.join(root, 'opt/OpenChamber/resources/app.asar.unpacked/node_modules', name), 'x64');
  }
  const applicationsDir = path.join(root, 'usr/share/applications');
  fs.mkdirSync(applicationsDir, { recursive: true });
  fs.writeFileSync(path.join(applicationsDir, 'openchamber.desktop'), [
    '[Desktop Entry]', 'Name=OpenChamber', 'Exec=/opt/OpenChamber/openchamber --no-sandbox %U', 'Icon=openchamber', 'StartupWMClass=openchamber', '',
  ].join('\n'));
  writeLauncherIcon(root);
  return root;
};

test('deb arch suffixes match electron-builder naming', () => {
  assert.equal(linuxDebArchSuffix('x64'), 'amd64');
  assert.equal(linuxDebArchSuffix('arm64'), 'arm64');
});

test('reads ar members from a synthetic deb archive', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-deb-test-'));
  try {
    const debPath = path.join(temp, 'openchamber_1.21.1_amd64.deb');
    writeDeb(debPath, [
      { name: 'debian-binary', data: Buffer.from('2.0\n') },
      { name: 'control.tar.xz', data: Buffer.from('fake-control') },
      { name: 'data.tar.xz', data: Buffer.from('fake-data') },
    ]);
    const members = readDebMembers(debPath);
    assert.deepEqual(members.map((m) => m.name).sort(), ['control.tar.xz', 'data.tar.xz', 'debian-binary']);
    // deceptively simple: 'fake-data' is 9 bytes odd, padded to 10 by the writer.
    assert.equal(members.find((m) => m.name === 'data.tar.xz').size, 9);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects non-ar input', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-deb-test-'));
  try {
    const bad = path.join(temp, 'bad.deb');
    fs.writeFileSync(bad, 'not an archive');
    assert.throws(() => readDebMembers(bad), /Not an ar/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('verifies identity, version, and native payload architecture', () => {
  const root = createPayload();
  try {
    const result = verifyDebPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.18',
    });
    assert.equal(result.nativeModuleCount, 2);
    assert.equal(result.openCodeVersion, '1.17.18');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a missing indexed launcher icon',
  () => {
    const root = createPayload();
    try {
      fs.rmSync(path.join(root, 'usr/share/icons/hicolor/512x512/apps/openchamber.png'));
      assert.throws(() => verifyDebPayload({
        root,
        targetArchitecture: 'x64',
        expectedOpenCodeVersion: '1.17.18',
        runCliVersion: () => '1.17.18',
      }), /Missing launcher icon at an indexed hicolor size/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('fails when the launcher icon is not a PNG',
  () => {
    const root = createPayload();
    try {
      fs.writeFileSync(path.join(root, 'usr/share/icons/hicolor/512x512/apps/openchamber.png'), 'not an image');
      assert.throws(() => verifyDebPayload({
        root,
        targetArchitecture: 'x64',
        expectedOpenCodeVersion: '1.17.18',
        runCliVersion: () => '1.17.18',
      }), /Launcher icon is not a portable-network-graphic/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('fails on a missing native module', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'opt/OpenChamber/resources/app.asar.unpacked/node_modules/pty.node'));
    assert.throws(() => verifyDebPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.18',
    }), /Missing packaged native module: pty\.node/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on wrong CLI version or native architecture or desktop Exec', () => {
  const root = createPayload();
  try {
    assert.throws(() => verifyDebPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.17',
    }), /OpenCode CLI version mismatch/);

    writeElf(path.join(root, 'opt/OpenChamber/resources/app.asar.unpacked/node_modules/pty.node'), 'arm64');
    assert.throws(() => verifyDebPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.18',
    }), /Native module architecture mismatch/);

    fs.writeFileSync(path.join(root, 'usr/share/applications/openchamber.desktop'), [
      '[Desktop Entry]', 'Name=OpenChamber', 'Exec=/opt/Other/openchamber %U', 'Icon=openchamber', 'StartupWMClass=openchamber', '',
    ].join('\n'));
    assert.throws(() => verifyDebPayload({
      root,
      targetArchitecture: 'x64',
      expectedOpenCodeVersion: '1.17.18',
      runCliVersion: () => '1.17.18',
    }), /expected Exec to launch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
