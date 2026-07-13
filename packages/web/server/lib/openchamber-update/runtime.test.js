import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildUpdateHelperLaunchSpec, startUpdateTransaction } from './runtime.js';

describe('update transaction runtime', () => {
  it('moves systemd and launchd helpers into independent manager jobs', () => {
    expect(buildUpdateHelperLaunchSpec({
      id: 'tx-1',
      helperManager: 'systemd',
      helperRuntime: '/usr/bin/node',
      helperPath: '/tmp/helper.mjs',
      requestPath: '/tmp/request.json',
    })).toEqual({
      command: 'systemd-run',
      args: [
        '--user',
        '--collect',
        '--quiet',
        '--unit',
        'openchamber-update-tx-1',
        '/usr/bin/node',
        '/tmp/helper.mjs',
        '/tmp/request.json',
      ],
    });
    expect(buildUpdateHelperLaunchSpec({
      id: 'tx-1',
      helperManager: 'launchd',
      helperRuntime: '/usr/bin/node',
      helperPath: '/tmp/helper.mjs',
      requestPath: '/tmp/request.json',
    })).toEqual({
      command: '/bin/launchctl',
      args: [
        'submit',
        '-l',
        'dev.openchamber.update.tx-1',
        '--',
        '/usr/bin/node',
        '/tmp/helper.mjs',
        '/tmp/request.json',
      ],
    });
  });

  it('deletes one-shot secrets and records failure when helper launch throws', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-runtime-'));
    const secret = 'credential-&-not-for-status';
    try {
      await expect(startUpdateTransaction({
        openchamberDataDir: directory,
        currentVersion: '1.0.0',
        targetVersion: '1.1.0',
        packageManager: 'npm',
        packagePath: path.join(directory, 'package'),
        install: { command: 'npm', args: ['install'] },
        restart: {
          mode: 'daemon',
          command: process.execPath,
          args: ['cli.js'],
          env: { OPENCHAMBER_UI_PASSWORD: secret },
          healthUrl: 'http://127.0.0.1:4097/health',
        },
        spawnChild: vi.fn(() => { throw new Error('spawn failed'); }),
      })).rejects.toThrow('spawn failed');

      const transactionDirectories = fs.readdirSync(path.join(directory, 'updates'));
      expect(transactionDirectories).toHaveLength(1);
      const transactionDirectory = path.join(directory, 'updates', transactionDirectories[0]);
      const statusText = fs.readFileSync(path.join(transactionDirectory, 'status.json'), 'utf8');
      expect(JSON.parse(statusText)).toMatchObject({
        state: 'failed',
        errorCode: 'helper-start-failed',
      });
      expect(fs.existsSync(path.join(transactionDirectory, 'request.json'))).toBe(false);
      expect(statusText).not.toContain(secret);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
