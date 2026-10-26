import { describe, expect, it, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createManagedTunnelConfigRuntime } from './managed-config.js';

describe('managed remote tunnel config', () => {
  it('writes the next update after one failed with a full disk', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-managed-tunnels-'));
    const configPath = path.join(tempRoot, 'cloudflare-managed-remote-tunnels.json');
    let failNextWrite = true;
    const runtime = createManagedTunnelConfigRuntime({
      fsPromises: {
        ...fsPromises,
        writeFile: async (file, ...rest) => {
          if (failNextWrite && file === configPath) {
            failNextWrite = false;
            const error = new Error('ENOSPC: no space left on device, write');
            error.code = 'ENOSPC';
            throw error;
          }
          return fsPromises.writeFile(file, ...rest);
        },
      },
      path,
      normalizeManagedRemoteTunnelHostname: (value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''),
      normalizeManagedRemoteTunnelPresets: (value) => value,
      constants: {
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH: configPath,
        CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH: path.join(tempRoot, 'legacy.json'),
        CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION: 1,
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tunnel = { id: 'a', name: 'A', hostname: 'a.example.com' };
    try {
      await expect(runtime.upsertManagedRemoteTunnelToken({ ...tunnel, token: 'first' })).rejects.toThrow('ENOSPC');
      await expect(runtime.upsertManagedRemoteTunnelToken({ ...tunnel, token: 'second' })).resolves.toBeUndefined();
      const onDisk = await runtime.readManagedRemoteTunnelConfigFromDisk();
      expect(onDisk.tunnels).toMatchObject([{ ...tunnel, token: 'second' }]);
    } finally {
      warn.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
