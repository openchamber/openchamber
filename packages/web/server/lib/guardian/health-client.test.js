import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  performConnectionBoundManagedOpenCodeHealth,
} from './health-client.js';
import {
  createManagedOpenCodeHealthProof,
  MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER,
  MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER,
  MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER,
  MANAGED_OPENCODE_HEALTH_OWNER_HEADER,
  MANAGED_OPENCODE_HEALTH_PORT_HEADER,
  MANAGED_OPENCODE_HEALTH_PROOF_HEADER,
  MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER,
} from './health-proof.js';

const servers = [];
const record = {
  incarnation: 'health-client-incarnation',
  ownerInstanceId: 'health-client-owner',
  runtimeIdentity: 'health-client-runtime',
  launchFingerprint: 'health-client-launch',
  port: 0,
};
const credential = { username: 'opencode', password: 'health-client-password' };

// This is a test-only certificate whose private key is not used anywhere
// outside this fixture. TLS verification is disabled only around the HTTPS
// regression below so the test can exercise the request path without adding a
// generated asset or a new dependency.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDpxqKqzq8PuOuo
M09X1gdh6V1nMmJ6Oqk/d8ZSAHhGBTjB5BBILtrxJPAdsNCRc8gPCtSuAzu9r0ct
D2znJjto8HO3a0s/4mlqMQ8iSvfH0c8nGLPxRXg0C9tR0VOyqJrqAPn9X6utxVQj
H2jLjZngZllhqlxIUxYuXO7MZfC2MQ4DRsp6GaJTftcOxTxevMdT6lK0yl3mDn0W
DyV9aWR5oCVXKIRK7jmF9bi9ETHwJHffFrduaaKYLQ/UOEtNek/pJsz0DNO0ePkm
DAt0GQkX3hmKd0VRgGEtaO+MAGbrDucPuDylMkC1GJm1lq6+6rkyQRNoAd8/yOJD
GihBJmLPAgMBAAECggEBAL3+WM/3IGHnyWavJMnfQaq6rdWkJlLugAT8BCs7BITr
04AJKY5wvjID8j4/KJM+BRbsl4NBT3lPDcq6YajO8rPL0E/+nG60RTYv3vvg79Xv
V6uPsRbifdnW1Q1+0cY+r4CFAKeC7JVS7ZmJ+nKMh8XPiM8OVOfW1w0hLFbkdqiq
UetA5H0oiJr0rFWh9Gfzc0avpmawXmZJqK8lKWB1rt2teu3bQWqn20dGr2IyCipz
KlGh3QImYogjqWEqPyowPGxnq8KWQ40Pjx61dy6cqYrw77yxLHGR8Az+TlRQZf/K
BeT3UkXCU5BTyC3PKZJpcYB/GMB8GBKRdNK+8H3OXskCgYEA963tUnLoiCwJjxvv
gIiMY5mIUAMnTDsCxSYekfkDvt4qdttn/+Y8/5/lXMSlCt+WZcXH0V8gmVOMqfHB
QRXWpi0uJnl9sUllb80Mw5PnS317UlJIbkro3crVUhIbrn9tKVFP1GO9xszNda8E
MkHV8FGmSaihXGnA8KEkTKg1CisCgYEA8aEjATIpDXyxQM4M9B1S0jI/nHOrg2lr
dMKQWJVruuvwrrZl6CFNIm2/PBXyHjCXqROXs7aXkE3vfRSypYNKBZl7BX08c0nE
koMVXwhGbSbUXjFx5bcUKaG/2eOK+ZV4ivNQokq1iIK+WKINAfP69ewzD7EAgbBg
KY7owSxka+0CgYB4Urh+W3B35tzl9y5NBQkewdGk/UM0F17rI++p/o1BRnDeuQw3
F0T+8lDc1nNPavuHiaPfJRWTJzGoxdeapN9Yb46CBnd3jy6GN9lBkjLFS7qDbZHe
cunaBdXIPx/Pj/waHHRpu+LQF2KhD1s8hxtF2oSsOA3b9UxUGhSmYPkTbQKBgEP8
muTTQEnTM+yQDYUCWzNZgBx9T10CZIHN3N+P62gEywvdtn7CH/n39z7ozd9AvOuN
37lpPuwTgbcoA7weXM2Gid7ZhhDKSM0QpQrAQVClBEwcjXedM8cjA+BC7e+b5vbx
z1ZavwlSAEzgC9jo1Uws0ZEwtHvJLMWEuGjiHL9hAoGAWEbj2cxhpCKTK3C8Qf+C
BscBwAZKmUasdWQBUzRFpR1UAO3fFBatjMPwrFYnt+ZgiCXTGFcoEa7mjoP/r5Mh
j1nRCoPQVcbmB1B9AtiaEa1AA+BqYF1r2aErbcsGrCV5OHU7TYFk1dep1SAQP/0W
9MQ+1Af5ttYSFYlJLnWJo4M=
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDPjCCAiagAwIBAgIJALrth9K8D7HIMA0GCSqGSIb3DQEBCwUAMF0xCzAJBgNV
BAYTAlVTMQswCQYDVQQIDAJDQTEQMA4GA1UECgwHTm9kZS5qczERMA8GA1UECwwI
bm9kZS1neXAxHDAaBgNVBAMME25vZGUtZ3lwLm5vZGVqcy5vcmcwHhcNMjMwOTI4
MDUxODM2WhcNMzMwOTI1MDUxODM2WjBgMQswCQYDVQQGEwJVUzETMBEGA1UECAwK
Q2FsaWZvcm5pYTEWMBQGA1UEBwwNU2FuIEZyYW5jaXNjbzEQMA4GA1UECgwHTm9k
ZS5qczESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
MIIBCgKCAQEA6caiqs6vD7jrqDNPV9YHYeldZzJiejqpP3fGUgB4RgU4weQQSC7a
8STwHbDQkXPIDwrUrgM7va9HLQ9s5yY7aPBzt2tLP+JpajEPIkr3x9HPJxiz8UV4
NAvbUdFTsqia6gD5/V+rrcVUIx9oy42Z4GZZYapcSFMWLlzuzGXwtjEOA0bKehmi
U37XDsU8XrzHU+pStMpd5g59Fg8lfWlkeaAlVyiESu45hfW4vREx8CR33xa3bmmi
mC0P1DhLTXpP6SbM9AzTtHj5JgwLdBkJF94ZindFUYBhLWjvjABm6w7nD7g8pTJA
tRiZtZauvuq5MkETaAHfP8jiQxooQSZizwIDAQABMA0GCSqGSIb3DQEBCwUAA4IB
AQBwgEyrqJOV8SC7PVTtEOqfSyrM7lJjVcmwXEIFPVCPxXnDtLS9+OaQe9ybjOR/
Bi/AvZK4gwsV9G5Bvbl0/sphYEKYLEpP76jhdETcBwhaEgK3itumoREeriut4bZI
OM6b1O45CoD67Lm87CUwLOdcNzPu4k7mat+xog5aFwaQuRjLBmmZcjl41QjVr9ti
La4PCMh7NwVMtHRqbYvgq785PsKAh+j4FSX1sj9NRzRPoJJ2qsre1Qn5tL/i6ovj
6s+3GxOQ5I1UzJX22PZFu003a582ha1CEFM0VaeDzzwbGNcV5SP+g2nw55zx9YRR
Rg8nGmjRuRtbs+/XAre2eQ5p
-----END CERTIFICATE-----`;

const listen = (server, host = '127.0.0.1') => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, host, () => {
    server.off('error', reject);
    resolve(server.address().port);
  });
});

const IPV6_LOOPBACK_UNAVAILABLE_CODES = new Set([
  'EAFNOSUPPORT',
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const probeIpv6Loopback = (port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: '::1', port });
  const finish = (result) => {
    socket.destroy();
    resolve(result);
  };
  socket.once('connect', () => finish({ available: true }));
  socket.once('error', (error) => {
    if (IPV6_LOOPBACK_UNAVAILABLE_CODES.has(error?.code)) {
      finish({ available: false });
      return;
    }
    socket.destroy();
    reject(error);
  });
});

const listenIpv6OrSkip = async (server, testContext) => {
  let port;
  try {
    port = await listen(server, '::1');
  } catch (error) {
    if (IPV6_LOOPBACK_UNAVAILABLE_CODES.has(error?.code)) {
      testContext.skip();
      return null;
    }
    throw error;
  }

  const probe = await probeIpv6Loopback(port);
  if (!probe.available) {
    testContext.skip();
    return null;
  }
  return port;
};

const close = (server) => new Promise((resolve) => {
  if (!server.listening) {
    resolve();
    return;
  }
  server.close(() => resolve());
});

const responseBody = JSON.stringify({ healthy: true });
const responseHeaders = (extra = {}) => ({
  'content-type': 'application/json',
  'content-length': Buffer.byteLength(responseBody),
  ...extra,
});

afterEach(async () => {
  while (servers.length > 0) await close(servers.pop());
});

describe('connection-bound managed health', () => {
  it('connects to an IPv6 listener and sends the bracketed Host header', async (testContext) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ host: request.headers.host, authorization: request.headers.authorization });
      const challenge = request.headers[MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER.toLowerCase()];
      const proof = createManagedOpenCodeHealthProof({
        password: credential.password,
        challenge,
        incarnation: request.headers[MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER.toLowerCase()],
        ownerInstanceId: request.headers[MANAGED_OPENCODE_HEALTH_OWNER_HEADER.toLowerCase()],
        runtimeIdentity: request.headers[MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER.toLowerCase()],
        launchFingerprint: request.headers[MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER.toLowerCase()],
        port: Number(request.headers[MANAGED_OPENCODE_HEALTH_PORT_HEADER.toLowerCase()]),
      });
      response.writeHead(200, responseHeaders({
        Connection: 'keep-alive',
        [MANAGED_OPENCODE_HEALTH_PROOF_HEADER]: proof,
      }));
      response.end(responseBody);
    });
    servers.push(server);

    const port = await listenIpv6OrSkip(server, testContext);
    if (port === null) return;
    const ipv6Record = { ...record, port };
    const connectSpy = vi.spyOn(net, 'connect');
    let result;
    try {
      result = await performConnectionBoundManagedOpenCodeHealth({
        url: `http://[::1]:${port}/global/health`,
        record: ipv6Record,
        credential,
      });
    } finally {
      connectSpy.mockRestore();
    }

    expect(result).toEqual({ healthy: true });
    expect(connectSpy).toHaveBeenCalledWith(expect.objectContaining({ host: '::1', port }));
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.host === `[::1]:${port}`)).toBe(true);
    expect(requests[0].authorization).toBeUndefined();
    expect(requests[1].authorization).toBe(`Basic ${Buffer.from('opencode:health-client-password').toString('base64')}`);
  });

  it('connects to an IPv6 TLS listener and preserves the request Host header', async (testContext) => {
    const requests = [];
    const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) => {
      requests.push({ host: request.headers.host, authorization: request.headers.authorization });
      const challenge = request.headers[MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER.toLowerCase()];
      const proof = createManagedOpenCodeHealthProof({
        password: credential.password,
        challenge,
        incarnation: request.headers[MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER.toLowerCase()],
        ownerInstanceId: request.headers[MANAGED_OPENCODE_HEALTH_OWNER_HEADER.toLowerCase()],
        runtimeIdentity: request.headers[MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER.toLowerCase()],
        launchFingerprint: request.headers[MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER.toLowerCase()],
        port: Number(request.headers[MANAGED_OPENCODE_HEALTH_PORT_HEADER.toLowerCase()]),
      });
      response.writeHead(200, responseHeaders({
        Connection: 'keep-alive',
        [MANAGED_OPENCODE_HEALTH_PROOF_HEADER]: proof,
      }));
      response.end(responseBody);
    });
    servers.push(server);

    const port = await listenIpv6OrSkip(server, testContext);
    if (port === null) return;
    const ipv6Record = { ...record, port };
    const previousTlsVerification = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const connectSpy = vi.spyOn(tls, 'connect');
    let result;
    try {
      result = await performConnectionBoundManagedOpenCodeHealth({
        url: `https://[::1]:${port}/global/health`,
        record: ipv6Record,
        credential,
      });
    } finally {
      if (previousTlsVerification === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsVerification;
      connectSpy.mockRestore();
    }

    expect(result).toEqual({ healthy: true });
    expect(connectSpy).toHaveBeenCalledWith(expect.objectContaining({
      host: '::1',
      port,
      servername: '::1',
    }));
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.host === `[::1]:${port}`)).toBe(true);
    expect(requests[0].authorization).toBeUndefined();
    expect(requests[1].authorization).toBe(`Basic ${Buffer.from('opencode:health-client-password').toString('base64')}`);
  });

  it('sends Basic Auth only on the socket that returned the verified proof', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ socket: request.socket, authorization: request.headers.authorization });
      const challenge = request.headers[MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER.toLowerCase()];
      if (!request.headers.authorization) {
        const proof = createManagedOpenCodeHealthProof({
          password: credential.password,
          challenge,
          incarnation: request.headers[MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER.toLowerCase()],
          ownerInstanceId: request.headers[MANAGED_OPENCODE_HEALTH_OWNER_HEADER.toLowerCase()],
          runtimeIdentity: request.headers[MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER.toLowerCase()],
          launchFingerprint: request.headers[MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER.toLowerCase()],
          port: Number(request.headers[MANAGED_OPENCODE_HEALTH_PORT_HEADER.toLowerCase()]),
        });
        response.writeHead(200, responseHeaders({
          Connection: 'keep-alive',
          [MANAGED_OPENCODE_HEALTH_PROOF_HEADER]: proof,
        }));
        response.end(responseBody);
        return;
      }
      response.writeHead(200, responseHeaders({ Connection: 'close' }));
      response.end(responseBody);
    });
    servers.push(server);
    record.port = await listen(server);

    const result = await performConnectionBoundManagedOpenCodeHealth({
      url: `http://127.0.0.1:${record.port}/global/health`,
      record,
      credential,
    });

    expect(result).toEqual({ healthy: true });
    expect(requests).toHaveLength(2);
    expect(requests[0].authorization).toBeUndefined();
    expect(requests[1].authorization).toBe(`Basic ${Buffer.from('opencode:health-client-password').toString('base64')}`);
    expect(requests[1].socket).toBe(requests[0].socket);
  });

  it('fails closed when the proof listener is swapped before authentication', async () => {
    let replacementRequests = 0;
    let replacement;
    let resolveSwap;
    const listenerSwapped = new Promise((resolve) => { resolveSwap = resolve; });
    const firstServer = http.createServer((request, response) => {
      const challenge = request.headers[MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER.toLowerCase()];
      const proof = createManagedOpenCodeHealthProof({
        password: credential.password,
        challenge,
        incarnation: request.headers[MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER.toLowerCase()],
        ownerInstanceId: request.headers[MANAGED_OPENCODE_HEALTH_OWNER_HEADER.toLowerCase()],
        runtimeIdentity: request.headers[MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER.toLowerCase()],
        launchFingerprint: request.headers[MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER.toLowerCase()],
        port: Number(request.headers[MANAGED_OPENCODE_HEALTH_PORT_HEADER.toLowerCase()]),
      });
      response.writeHead(200, responseHeaders({
        Connection: 'close',
        [MANAGED_OPENCODE_HEALTH_PROOF_HEADER]: proof,
      }));
      response.end(responseBody, () => {
        request.socket.destroy();
        firstServer.close(() => {
          replacement = http.createServer(() => {
            replacementRequests += 1;
          });
          servers.push(replacement);
          replacement.listen(record.port, '127.0.0.1', resolveSwap);
        });
      });
    });
    servers.push(firstServer);
    record.port = await listen(firstServer);

    const result = await performConnectionBoundManagedOpenCodeHealth({
      url: `http://127.0.0.1:${record.port}/global/health`,
      record,
      credential,
    });
    await listenerSwapped;

    expect(result).toMatchObject({
      healthy: false,
      credentialProofFailed: true,
    });
    expect(replacementRequests).toBe(0);
  });

  it('does not send Basic Auth to a stock or unproven endpoint', async () => {
    const authorizations = [];
    const server = http.createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, responseHeaders({ Connection: 'keep-alive' }));
      response.end(responseBody);
    });
    servers.push(server);
    record.port = await listen(server);

    const result = await performConnectionBoundManagedOpenCodeHealth({
      url: `http://127.0.0.1:${record.port}/global/health`,
      record,
      credential,
    });

    expect(result).toMatchObject({
      healthy: false,
      credentialProofFailed: true,
    });
    expect(authorizations).toEqual([undefined]);
  });

  it('returns credentialFailure (not a thrown error) when the pre-proof connection to a closed port is refused', async () => {
    // Bind + immediately close a server to claim a free port that nothing is
    // listening on. The unauthenticated probe should fail before any proof
    // is received, so the result must be a structured `credentialFailure`
    // envelope rather than an unhandled ReferenceError from the catch block.
    const closedPort = await new Promise((resolve, reject) => {
      const ephemeral = http.createServer();
      ephemeral.once('error', reject);
      ephemeral.listen(0, '127.0.0.1', () => {
        const { port } = ephemeral.address();
        ephemeral.close(() => resolve(port));
      });
    });
    const closedRecord = { ...record, port: closedPort };

    const result = await performConnectionBoundManagedOpenCodeHealth({
      url: `http://127.0.0.1:${closedPort}/global/health`,
      record: closedRecord,
      credential,
    });

    expect(result).toMatchObject({
      healthy: false,
      credentialUnavailable: true,
    });
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
