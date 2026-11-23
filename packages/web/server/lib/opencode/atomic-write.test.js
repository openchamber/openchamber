import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writeFileAtomic } from './atomic-write.js';

const FIXTURE_DIR = path.join(os.tmpdir(), `openchamber-atomic-write-test-${process.pid}`);

describe('writeFileAtomic', () => {
  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('writes string content', () => {
    const filePath = path.join(FIXTURE_DIR, 'a.txt');
    writeFileAtomic(filePath, 'hello');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello');
  });

  it('writes Uint8Array content byte-exact, including non-UTF8 bytes', () => {
    const filePath = path.join(FIXTURE_DIR, 'b.bin');
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x41, 0x80]);
    writeFileAtomic(filePath, bytes);
    expect([...fs.readFileSync(filePath)]).toEqual([...bytes]);
  });

  it('writes DataView content byte-exact over its window', () => {
    const filePath = path.join(FIXTURE_DIR, 'c.bin');
    const backing = new Uint8Array([0x09, 0x01, 0x02, 0x03, 0x09]);
    writeFileAtomic(filePath, new DataView(backing.buffer, 1, 3));
    expect([...fs.readFileSync(filePath)]).toEqual([0x01, 0x02, 0x03]);
  });

  it('keeps a symlinked target a symlink and writes through to the target', () => {
    const target = path.join(FIXTURE_DIR, 'target.txt');
    const link = path.join(FIXTURE_DIR, 'link.txt');
    fs.writeFileSync(target, 'old', 'utf8');
    fs.symlinkSync(target, link);
    writeFileAtomic(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
  });

  it('preserves the existing file mode', () => {
    const filePath = path.join(FIXTURE_DIR, 'mode.txt');
    fs.writeFileSync(filePath, 'old', 'utf8');
    fs.chmodSync(filePath, 0o640);
    writeFileAtomic(filePath, 'new');
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o640);
  });

  it('leaves no temp files behind', () => {
    const filePath = path.join(FIXTURE_DIR, 'clean.txt');
    writeFileAtomic(filePath, 'x');
    expect(fs.readdirSync(FIXTURE_DIR)).toEqual(['clean.txt']);
  });
});
