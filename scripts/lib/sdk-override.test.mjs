import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pointSdkAtArchive } from './sdk-override.mjs';

const withDirectory = (run) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sdk-override-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const read = (directory) => JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
const write = (directory, manifest) => writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));

test('writes a forward-slash file: override for a Windows path into an empty manifest', () => {
  withDirectory((directory) => {
    write(directory, {});
    pointSdkAtArchive(directory, 'C:\\Users\\dev\\openchamber\\openchamber-sdk-1.24.2.tgz');
    assert.deepEqual(read(directory), {
      overrides: { '@openchamber/sdk': 'file:C:/Users/dev/openchamber/openchamber-sdk-1.24.2.tgz' },
    });
  });
});

test('creates the manifest when the directory has none', () => {
  withDirectory((directory) => {
    const nested = path.join(directory, 'global');
    pointSdkAtArchive(nested, '/repo/openchamber-sdk-1.24.2.tgz');
    assert.equal(read(nested).overrides['@openchamber/sdk'], 'file:/repo/openchamber-sdk-1.24.2.tgz');
  });
});

test('restoring removes only its own override and keeps dependencies added meanwhile', () => {
  withDirectory((directory) => {
    write(directory, { dependencies: { other: '1.0.0' }, overrides: { other: '1.0.1' } });
    const restore = pointSdkAtArchive(directory, '/repo/openchamber-sdk-1.24.2.tgz');
    // What `bun add -g` does to the manifest between the two calls.
    write(directory, { ...read(directory), dependencies: { other: '1.0.0', '@openchamber/web': '/repo/openchamber-web-1.24.2.tgz' } });
    restore();
    assert.deepEqual(read(directory), {
      dependencies: { other: '1.0.0', '@openchamber/web': '/repo/openchamber-web-1.24.2.tgz' },
      overrides: { other: '1.0.1' },
    });
  });
});

test('restoring drops an overrides object it created and puts back a previous SDK override', () => {
  withDirectory((directory) => {
    write(directory, {});
    pointSdkAtArchive(directory, '/repo/a.tgz')();
    assert.deepEqual(read(directory), {});

    write(directory, { overrides: { '@openchamber/sdk': '1.24.1' } });
    pointSdkAtArchive(directory, '/repo/b.tgz')();
    assert.deepEqual(read(directory), { overrides: { '@openchamber/sdk': '1.24.1' } });
  });
});
