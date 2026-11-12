import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetwork } from './network.js';
import { layout } from './state.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

/** A holder that exits without printing, its pipes already closed: Node emits exit and close in one callback. */
const exitingHolder = (stderr) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  setTimeout(() => {
    child.stderr.write(stderr);
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
  }, 10);
  return child;
};

describe('the space network', () => {
  it('fails, and does not wait forever, when the namespace holder exits on its own', async () => {
    // Given a holder that exits at once, as one that cannot enter its namespaces does.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-network-')); roots.push(root);
    const system = {
      run: vi.fn(async (file) => (file === '/usr/bin/getent' ? { code: 0, stdout: 'openchamber-net-aabbcc112233:x:996:996::/nonexistent:/usr/sbin/nologin\n', stderr: '' } : { code: 0, stdout: '', stderr: '' })),
      spawn: vi.fn(() => exitingHolder('unshare: unshare failed: Operation not permitted\n')),
    };
    const network = createNetwork({ system, paths: layout(root), ipPath: '/usr/bin/ip' });
    // When the space's network is made, then the create fails with the holder's reason, in bounded time.
    const outcome = await Promise.race([
      network.create({ id: 'aabbcc112233', subnet: 0 }).then(() => 'created', (error) => error),
      new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 2000); }),
    ]);
    expect(outcome).toMatchObject({ code: 'namespace_failed', message: expect.stringContaining('Operation not permitted') });
  });
});
