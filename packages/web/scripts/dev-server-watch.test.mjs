import { describe, expect, it } from 'vitest';

import { createDevServerWatchCommand } from './dev-server-watch.mjs';

describe('createDevServerWatchCommand', () => {
  it('preserves the injected desktop dev data directory for the HMR server', () => {
    const command = createDevServerWatchCommand({
      platform: 'linux', bunExecutable: 'bun',
      env: {
        OPENCHAMBER_ELECTRON_DEV: '1',
        OPENCHAMBER_DATA_DIR: '/dev-data',
        OPENCHAMBER_ELECTRON_DEV_DATA_DIR: '/dev-data',
        OPENCHAMBER_INJECTED_ENV: 'OPENCHAMBER_DATA_DIR,OPENCHAMBER_UI_PASSWORD',
        OPENCHAMBER_UI_PASSWORD: 'secret',
      },
    });
    expect(command.spawnOptions.env.OPENCHAMBER_DATA_DIR).toBe('/dev-data');
    expect(command.spawnOptions.env.OPENCHAMBER_INJECTED_ENV).toBe('OPENCHAMBER_DATA_DIR');
    expect(command.spawnOptions.env.OPENCHAMBER_UI_PASSWORD).toBeUndefined();
    expect(command.spawnOptions.env.OPENCHAMBER_ELECTRON_DEV_DATA_DIR).toBeUndefined();
  });

  it('retains an explicitly supplied desktop data directory without marking it injected', () => {
    const command = createDevServerWatchCommand({
      platform: 'linux', bunExecutable: 'bun',
      env: {
        OPENCHAMBER_ELECTRON_DEV: '1',
        OPENCHAMBER_DATA_DIR: '/custom',
        OPENCHAMBER_ELECTRON_DEV_DATA_DIR: '/custom',
      },
    });
    expect(command.spawnOptions.env.OPENCHAMBER_DATA_DIR).toBe('/custom');
    expect(command.spawnOptions.env.OPENCHAMBER_INJECTED_ENV).toBeUndefined();
    expect(command.spawnOptions.env.OPENCHAMBER_ELECTRON_DEV_DATA_DIR).toBeUndefined();
  });
  it('uses the package default port and disables relay hosting by default', () => {
    const command = createDevServerWatchCommand({
      platform: 'win32',
      env: {},
      bunExecutable: '/opt/bun/bin/bun',
    });

    expect(command.command).toBe('/opt/bun/bin/bun');
    expect(command.args).toEqual(['--watch', 'server/index.js', '--port', '3001']);
    expect(command.spawnOptions.env.OPENCHAMBER_RELAY_HOST).toBe('off');
    expect(command.spawnOptions.windowsHide).toBe(true);
  });

  it('passes the configured port and relay host to the Bun watcher', () => {
    const command = createDevServerWatchCommand({
      platform: 'win32',
      env: {
        OPENCHAMBER_PORT: '58992',
        OPENCHAMBER_RELAY_HOST: 'relay.example.test',
      },
      bunExecutable: 'C:\\Tools\\Bun\\bun.exe',
    });

    expect(command.args).toEqual(['--watch', 'server/index.js', '--port', '58992']);
    expect(command.spawnOptions.env.OPENCHAMBER_RELAY_HOST).toBe('relay.example.test');
  });

  it('rejects an invalid configured port before spawning', () => {
    expect(() => createDevServerWatchCommand({
      platform: 'win32',
      env: { OPENCHAMBER_PORT: 'not-a-port' },
      bunExecutable: 'bun',
    })).toThrow(/Invalid OPENCHAMBER_PORT/);
  });

  it('preserves the nodemon watcher command outside Windows', () => {
    const command = createDevServerWatchCommand({
      platform: 'linux',
      env: { OPENCHAMBER_PORT: '4200' },
      bunExecutable: '/opt/bun/bin/bun',
    });

    expect(command.command).toBe('/opt/bun/bin/bun');
    expect(command.args).toEqual([
      'x',
      'nodemon',
      '--watch',
      'server',
      '--ext',
      'js',
      '--exec',
      'bun server/index.js --port 4200',
    ]);
  });

  it('drops what an OpenChamber app put into the shell and keeps the user\'s own exports', () => {
    const command = createDevServerWatchCommand({
      platform: 'linux',
      env: {
        PATH: '/usr/bin',
        OPENCHAMBER_PORT: '4200',
        OPENCHAMBER_UI_PASSWORD: 'desktop-secret',
        OPENCHAMBER_RUNTIME: 'desktop',
        OPENCODE_PASSWORD: 'theirs',
        OPENCHAMBER_INJECTED_ENV: 'OPENCHAMBER_UI_PASSWORD,OPENCHAMBER_RUNTIME',
      },
      bunExecutable: 'bun',
    });

    const { env } = command.spawnOptions;
    expect(env).not.toHaveProperty('OPENCHAMBER_UI_PASSWORD');
    expect(env).not.toHaveProperty('OPENCHAMBER_RUNTIME');
    expect(env).not.toHaveProperty('OPENCHAMBER_INJECTED_ENV');
    expect(env).toMatchObject({ PATH: '/usr/bin', OPENCHAMBER_PORT: '4200', OPENCODE_PASSWORD: 'theirs' });
  });
});
