import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineRequest } from '../test-support/fixtures.js';
import { createProtectedMcpService } from './service.js';
import { openStore } from './store.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('broker startup', () => {
  it('releases its listener and state lock when the admin socket cannot start', async () => {
    // Given
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-start-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const adminSocketPath = path.join(root, 'admin.sock');
    await fs.writeFile(adminSocketPath, 'occupied');
    const stateDir = path.join(root, 'state');
    const engineSocketPath = path.join(root, 'engine.sock');
    const service = await createProtectedMcpService({ version: 'test', stateDir, engineSocketPath, adminSocketPath, integrity: { owners: [process.getuid()], engine: { uid: 2_000_000_002, gids: [] } }, enforcement: async () => ({ status: 'protected', checkedAt: 0, findings: [] }) });
    // When
    await expect(service.start()).rejects.toThrow('admin socket path is occupied');
    // Then
    await expect(engineRequest(engineSocketPath, { type: 'status' })).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });
    const next = await openStore({ stateDir });
    cleanups.push(next.close);
    expect(next.list()).toEqual([]);
  });
});
