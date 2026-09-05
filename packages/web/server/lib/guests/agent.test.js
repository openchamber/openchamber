import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getAgentStatus,
  proxyGuestAgentRequest,
  setAgentGranted,
  stopAllGuestAgents,
  stopGuestAgent,
} from './agent.js';
import { writeExtensionStore } from './persist.js';

const writeFixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-agent-'));
  const persistPath = path.join(dir, 'extensions.json');
  const packageRoot = path.join(dir, 'docker');
  await fs.mkdir(path.join(packageRoot, 'agent'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'agent', 'main.js'), `
import http from 'node:http';
const port = Number(process.env.OPENCHAMBER_AGENT_PORT);
const token = process.env.OPENCHAMBER_AGENT_TOKEN;
http.createServer((req, res) => {
  if (req.headers.authorization !== \`Bearer \${token}\`) {
    res.writeHead(401);
    res.end('no');
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pong: true }));
    return;
  }
  res.writeHead(404);
  res.end('missing');
}).listen(port, '127.0.0.1');
`);
  await writeExtensionStore(persistPath, { paths: [packageRoot], sources: {}, agentGrants: {} });
  return { dir, persistPath, packageRoot };
};

afterEach(async () => {
  await stopAllGuestAgents();
});

describe('guest agent proxy', () => {
  test('refuses when permissions need a grant', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await expect(proxyGuestAgentRequest({
        guestId: 'docker',
        packageRoot,
        agent: {
          entry: 'agent/main.js',
          permissions: { exec: ['docker'] },
        },
        persistPath,
        method: 'GET',
        path: '/ping',
      })).rejects.toMatchObject({ code: 'NO_AGENT' });
      expect(getAgentStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('spawns, proxies, and reports ready', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setAgentGranted('docker', persistPath, true);
      const result = await proxyGuestAgentRequest({
        guestId: 'docker',
        packageRoot,
        agent: {
          entry: 'agent/main.js',
          permissions: { exec: ['docker'] },
        },
        persistPath,
        method: 'GET',
        path: '/ping',
      });
      expect(result).toEqual({ status: 200, body: '{"pong":true}' });
      expect(getAgentStatus('docker')).toBe('ready');
      await stopGuestAgent('docker');
      expect(getAgentStatus('docker')).toBe('stopped');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('coalesces parallel first requests onto one spawn', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setAgentGranted('docker', persistPath, true);
      const agent = {
        entry: 'agent/main.js',
        permissions: { exec: ['docker'] },
      };
      const results = await Promise.all([
        proxyGuestAgentRequest({
          guestId: 'docker',
          packageRoot,
          agent,
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
        proxyGuestAgentRequest({
          guestId: 'docker',
          packageRoot,
          agent,
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
        proxyGuestAgentRequest({
          guestId: 'docker',
          packageRoot,
          agent,
          persistPath,
          method: 'GET',
          path: '/ping',
        }),
      ]);
      expect(results).toEqual([
        { status: 200, body: '{"pong":true}' },
        { status: 200, body: '{"pong":true}' },
        { status: 200, body: '{"pong":true}' },
      ]);
      expect(getAgentStatus('docker')).toBe('ready');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a path with a scheme', async () => {
    const { dir, persistPath, packageRoot } = await writeFixture();
    try {
      await setAgentGranted('docker', persistPath, true);
      await expect(proxyGuestAgentRequest({
        guestId: 'docker',
        packageRoot,
        agent: { entry: 'agent/main.js' },
        persistPath,
        method: 'GET',
        path: 'http://evil.example/ping',
      })).rejects.toMatchObject({ code: 'BAD_PATH' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
