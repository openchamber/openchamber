import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPeArchitecture } from './windows-executable.mjs';

const writePe = (machine) => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-pe-test-')), 'opencode.exe');
  const header = Buffer.alloc(0x86);
  header.write('MZ', 0, 'latin1');
  header.writeUInt32LE(0x80, 0x3c);
  header.write('PE\0\0', 0x80, 'latin1');
  header.writeUInt16LE(machine, 0x84);
  fs.writeFileSync(filePath, header);
  return filePath;
};

test('reads the architecture a Windows executable is built for', () => {
  assert.equal(readPeArchitecture(writePe(0x8664)), 'x64');
  assert.equal(readPeArchitecture(writePe(0xaa64)), 'arm64');
});

test('rejects an unsupported PE machine', () => {
  assert.throws(() => readPeArchitecture(writePe(0x14c)), /Unsupported PE machine 0x14c/);
});

test('rejects a file that is not a Windows executable', () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-pe-test-')), 'opencode');
  fs.writeFileSync(filePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.throws(() => readPeArchitecture(filePath), /Expected a Windows executable/);
});
