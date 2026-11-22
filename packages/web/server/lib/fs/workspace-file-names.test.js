import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { createWorkspaceFileNameIndex } from './workspace-file-names.js';

// A git child that prints `output` and exits, or never finishes when output is null.
const fakeSpawn = (outputs) => {
  const calls = [];
  const spawn = () => {
    calls.push(1);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => { child.killed = true; };
    const output = outputs[Math.min(calls.length - 1, outputs.length - 1)];
    if (output !== null) {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(output));
        child.emit('close', 0);
      });
    }
    return child;
  };
  return { spawn, calls };
};

const listing = ['src/chat/Renderer.tsx', 'lib/util.ts', 'src/util.ts', ''].join('\0');

describe('createWorkspaceFileNameIndex', () => {
  it('answers every name from one listing and shares it between concurrent lookups', async () => {
    const { spawn, calls } = fakeSpawn([listing]);
    const index = createWorkspaceFileNameIndex({ spawn, resolveGitBinary: () => 'git' });
    const [renderer, util, missing] = await Promise.all([
      index.find('/repo', 'Renderer.tsx'),
      index.find('/repo', 'util.ts'),
      index.find('/repo', 'Missing.ts'),
    ]);
    expect(renderer).toEqual([path.join('/repo', 'src/chat/Renderer.tsx')]);
    expect(util).toHaveLength(2);
    expect(missing).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('lists again once the cached listing is older than the TTL', async () => {
    let clock = 0;
    const { spawn, calls } = fakeSpawn([listing, `${listing}src/New.ts\0`]);
    const index = createWorkspaceFileNameIndex({ spawn, resolveGitBinary: () => 'git', ttlMs: 1000, now: () => clock });
    expect(await index.find('/repo', 'New.ts')).toEqual([]);
    clock = 500;
    expect(await index.find('/repo', 'New.ts')).toEqual([]);
    clock = 2000;
    expect(await index.find('/repo', 'New.ts')).toEqual([path.join('/repo', 'src/New.ts')]);
    expect(calls).toHaveLength(2);
  });

  it('does not resurrect an evicted workspace when its listing finishes last', async () => {
    // Children finish only when the test completes them, so the order is
    // deterministic: nine concurrent loads, the eight newer listings
    // complete first, the evicted oldest completes last (#2161).
    const children = [];
    const spawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    };
    const finish = (child) => {
      child.stdout.emit('data', Buffer.from(listing));
      child.emit('close', 0);
    };
    const index = createWorkspaceFileNameIndex({ spawn, resolveGitBinary: () => 'git' });
    const dirs = Array.from({ length: 9 }, (_, i) => `/ws${i}`);
    const pending = dirs.map((directory) => index.find(directory, 'util.ts'));
    expect(children).toHaveLength(9);
    for (let i = 8; i >= 1; i--) finish(children[i]);
    finish(children[0]);
    await Promise.all(pending);
    // The evicted oldest entry was not reinserted on completion: looking
    // it up again starts a fresh listing instead of reusing the result.
    const again = index.find(dirs[0], 'util.ts');
    expect(children).toHaveLength(10);
    finish(children[9]);
    await again;
    // A workspace that stayed resident is still served from the cache.
    await index.find(dirs[8], 'util.ts');
    expect(children).toHaveLength(10);
  });

  it('gives no match for a listing over the size cap or past the deadline', async () => {
    const big = createWorkspaceFileNameIndex({ spawn: fakeSpawn([listing]).spawn, resolveGitBinary: () => 'git', maxOutputBytes: 8 });
    expect(await big.find('/repo', 'util.ts')).toEqual([]);
    const slow = createWorkspaceFileNameIndex({ spawn: fakeSpawn([null]).spawn, resolveGitBinary: () => 'git', timeoutMs: 10 });
    expect(await slow.find('/repo', 'util.ts')).toEqual([]);
  });
});
