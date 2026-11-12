import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { classifyProxyTarget, createPolicyProxy } from '../src/policy-proxy.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const handshake = (authority, absolute = false) => `GET ${absolute ? `ws://${authority}` : ''}/socket HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

const exchange = (port, message) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let response = '';
  socket.setTimeout(3_000, () => socket.destroy(new Error('Proxy handshake timed out')));
  socket.on('error', reject);
  socket.on('data', (chunk) => {
    response += chunk;
    if (/HTTP\/1\.1 (101|403) /.test(response) && response.includes('\r\n\r\n')) {
      socket.destroy();
      resolve(response);
    }
  });
  socket.on('end', () => {
    socket.destroy();
    reject(new Error(`Proxy ended without a handshake: ${response}`));
  });
  socket.write(message);
});

for (const transport of ['upgrade', 'connect']) {
  for (const privateAllowed of [false, true]) {
    test(`refuses own endpoints over ${transport} with private networks ${privateAllowed ? 'allowed' : 'grant-only'}`, { timeout: 10_000 }, async (context) => {
      // Given reachable protected and allowed servers, including matching grants.
      const counters = { protected: 0, allowed: 0 };
      const connections = { protected: 0, allowed: 0 };
      const servers = [];
      const ports = {};
      for (const name of ['protected', 'allowed']) {
        const server = http.createServer((_req, res) => { counters[name] += 1; res.end('http'); });
        server.on('connection', () => { connections[name] += 1; });
        server.on('upgrade', (req, socket) => {
          counters[name] += 1;
          const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        });
        servers.push(server);
        ports[name] = await listen(server);
      }
      const grants = Object.values(ports).map((port) => ({ host: '127.0.0.1', port }));
      const proxy = createPolicyProxy({
        openchamberOrigins: [`http://localhost:${ports.protected}`],
        grants, devServerGrants: async () => grants, allowPrivateNetwork: () => privateAllowed,
      });
      context.after(async () => {
        await proxy.close();
        for (const server of servers) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      });
      const proxyPort = Number((await proxy.listen()).split(':').at(-1));
      const message = (port) => {
        const authority = `127.0.0.1:${port}`;
        return transport === 'connect'
          ? `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${handshake(authority)}`
          : handshake(authority, true);
      };
      // When the same wire handshake targets allowed and protected endpoints.
      const allowed = await exchange(proxyPort, message(ports.allowed));
      const denied = await exchange(proxyPort, message(ports.protected));
      // Then the positive control upgrades and the protected server sees no connection.
      assert.match(allowed, /HTTP\/1\.1 101 /);
      if (transport === 'connect') assert.match(allowed, /HTTP\/1\.1 200 Connection Established/);
      assert.match(denied, /^HTTP\/1\.1 403 /);
      assert.deepEqual(counters, { protected: 0, allowed: 1 });
      assert.equal(connections.protected, 0);
    });
  }
}

test('classifies protected endpoints before DNS, discovery or private-network probes', async () => {
  // Given a front-door endpoint and callbacks that must never run for it.
  const policy = {
    openchamberOrigins: ['http://FRONT.example.:3000'],
    allowPrivateNetwork: true,
    lookup: async () => { throw new Error('Unexpected DNS'); },
    devServerGrants: async () => { throw new Error('Unexpected discovery'); },
  };
  // When its hostname and port appear under HTTP, WS or a CONNECT-style HTTPS URL.
  for (const target of ['http://front.EXAMPLE:3000/', 'ws://front.example.:3000/socket', 'https://front.example:3000/']) {
    const decision = await classifyProxyTarget(target, policy);
    // Then the refusal is authoritative and cannot offer an egress grant.
    assert.equal(decision.allowed, false, target);
    assert.notEqual(decision.grantable, true);
    assert.equal(decision.reason, 'OpenChamber endpoint is denied');
  }
});
