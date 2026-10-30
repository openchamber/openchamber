const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { deriveExecutableUuid, setExecutableUuid } = require('./macos-executable-uuid.cjs');

const STOCK_UUID = Buffer.from('4c4c44aa55553144a1ed37cd3f6b77d3', 'hex');

// A thin arm64 Mach-O header followed by an LC_SEGMENT_64 and an LC_UUID.
const machO = () => {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(72 + 24, 20);
  const segment = Buffer.alloc(72);
  segment.writeUInt32LE(0x19, 0);
  segment.writeUInt32LE(72, 4);
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  STOCK_UUID.copy(uuid, 8);
  return Buffer.concat([header, segment, uuid, Buffer.from('code')]);
};

const withExecutable = (contents, run) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-executable-uuid-'));
  try {
    const executablePath = path.join(directory, 'OpenChamber');
    fs.writeFileSync(executablePath, contents);
    run(executablePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test('replaces only the UUID, with one derived from the appId', () => {
  const original = machO();
  withExecutable(original, (executablePath) => {
    setExecutableUuid(executablePath, 'dev.openchamber.desktop');
    const patched = fs.readFileSync(executablePath);
    const uuidOffset = 32 + 72 + 8;
    assert.deepEqual(patched.subarray(uuidOffset, uuidOffset + 16), deriveExecutableUuid('dev.openchamber.desktop'));
    assert.notDeepEqual(patched.subarray(uuidOffset, uuidOffset + 16), STOCK_UUID);
    assert.deepEqual(patched.subarray(0, uuidOffset), original.subarray(0, uuidOffset));
    assert.deepEqual(patched.subarray(uuidOffset + 16), original.subarray(uuidOffset + 16));
  });
});

test('the UUID is stable for an appId and differs between appIds', () => {
  assert.deepEqual(deriveExecutableUuid('dev.openchamber.desktop'), deriveExecutableUuid('dev.openchamber.desktop'));
  assert.notDeepEqual(deriveExecutableUuid('dev.openchamber.desktop'), deriveExecutableUuid('dev.openchamber.desktop.canary'));
});

test('an executable it cannot patch fails the build', () => {
  withExecutable(Buffer.from('#!/bin/sh\n'), (executablePath) => {
    assert.throws(() => setExecutableUuid(executablePath, 'dev.openchamber.desktop'), /thin 64-bit/);
  });
  const withoutUuid = machO();
  withoutUuid.writeUInt32LE(1, 16);
  withExecutable(withoutUuid, (executablePath) => {
    assert.throws(() => setExecutableUuid(executablePath, 'dev.openchamber.desktop'), /no LC_UUID/);
  });
});
