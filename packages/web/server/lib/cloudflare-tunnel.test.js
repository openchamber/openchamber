import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { startCloudflareManagedLocalTunnel, startCloudflareManagedRemoteTunnel } from './cloudflare-tunnel.js';

const originalPath = process.env.PATH || '';
const activeControllers = [];

function createFakeCloudflaredBinary() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-test-'));
  const binaryPath = path.join(tempDir, 'cloudflared');
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "cloudflared version test"
  exit 0
fi

if [ "$1" = "tunnel" ]; then
  echo "Registered tunnel connection" >&2
  while true; do
    sleep 1
  done
fi

echo "unexpected args: $@" >&2
exit 1
`;

  fs.writeFileSync(binaryPath, script, 'utf8');
  fs.chmodSync(binaryPath, 0o755);

  process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;

  return () => {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
}

afterEach(() => {
  while (activeControllers.length > 0) {
    const controller = activeControllers.pop();
    controller?.stop?.();
  }
  process.env.PATH = originalPath;
});

describe('managed remote cloudflare tunnel token-file', () => {
  it('uses --token-file instead of --token in process args', async () => {
    const cleanupBinary = createFakeCloudflaredBinary();
    try {
      const controller = await startCloudflareManagedRemoteTunnel({
        token: 'test-secret-token',
        hostname: 'remote.example.com',
      });
      activeControllers.push(controller);

      // Verify the token is not visible in the spawned process args
      const spawnArgs = controller.process?.spawnargs || [];
      const hasTokenFlag = spawnArgs.includes('--token');
      const hasTokenValue = spawnArgs.includes('test-secret-token');
      const hasTokenFileFlag = spawnArgs.includes('--token-file');
      expect(hasTokenFlag).toBe(false);
      expect(hasTokenValue).toBe(false);
      expect(hasTokenFileFlag).toBe(true);

      expect(controller.getPublicUrl()).toBe('https://remote.example.com');
    } finally {
      cleanupBinary();
    }
  });

  it('accepts explicit tokenFilePath', async () => {
    const cleanupBinary = createFakeCloudflaredBinary();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-tokenfile-'));
    try {
      const tokenPath = path.join(tempDir, 'token');
      fs.writeFileSync(tokenPath, 'my-file-token', { encoding: 'utf8', mode: 0o600 });

      const controller = await startCloudflareManagedRemoteTunnel({
        token: 'my-file-token',
        hostname: 'tokenfile.example.com',
        tokenFilePath: tokenPath,
      });
      activeControllers.push(controller);

      const spawnArgs = controller.process?.spawnargs || [];
      expect(spawnArgs.includes('--token')).toBe(false);
      expect(spawnArgs.includes('my-file-token')).toBe(false);
      expect(spawnArgs.includes('--token-file')).toBe(true);
      expect(spawnArgs.includes(tokenPath)).toBe(true);
    } finally {
      cleanupBinary();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('managed local cloudflare tunnel startup', () => {
  it('uses explicit config and extracts hostname from ingress', async () => {
    const cleanupBinary = createFakeCloudflaredBinary();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-config-'));
    try {
      const configPath = path.join(tempDir, 'config.yml');
      fs.writeFileSync(configPath, [
        'tunnel: test-tunnel',
        'credentials-file: /tmp/test.json',
        'ingress:',
        '  - hostname: tunnel.example.com',
        '    service: http://localhost:3000',
        '  - service: http_status:404',
      ].join('\n'), 'utf8');

      const controller = await startCloudflareManagedLocalTunnel({
        configPath,
        hostname: undefined,
      });

      activeControllers.push(controller);
      expect(controller.getPublicUrl()).toBe('https://tunnel.example.com');
      expect(controller.getResolvedHostname()).toBe('tunnel.example.com');
      expect(controller.getEffectiveConfigPath()).toBe(configPath);
    } finally {
      cleanupBinary();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails with actionable error when explicit config path is missing', async () => {
    const cleanupBinary = createFakeCloudflaredBinary();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-missing-'));
    try {
      const missingPath = path.join(tempDir, 'missing.yml');
      await expect(startCloudflareManagedLocalTunnel({
        configPath: missingPath,
      })).rejects.toThrow(/file was not found/i);
    } finally {
      cleanupBinary();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails with actionable error when config is invalid yaml', async () => {
    const cleanupBinary = createFakeCloudflaredBinary();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cf-invalid-'));
    try {
      const configPath = path.join(tempDir, 'config.yml');
      fs.writeFileSync(configPath, 'ingress: [', 'utf8');

      await expect(startCloudflareManagedLocalTunnel({
        configPath,
      })).rejects.toThrow(/config is invalid/i);
    } finally {
      cleanupBinary();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
