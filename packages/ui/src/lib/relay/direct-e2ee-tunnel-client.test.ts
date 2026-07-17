import { describe, expect, test } from 'bun:test';

import { exportPublicKeyJwk, generateEcdhKeyPair } from './crypto';
import { createDirectE2eeChannelReadiness, createDirectE2eeTunnelClient } from './direct-e2ee-tunnel-client';
import { RelayCloseCode } from './protocol';
import { TunnelChannelReadinessError, type TunnelWireSocket } from './tunnel-client';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const runReadiness = (responses: Response[], token = 'secret-token') => {
  const requests: Request[] = [];
  const readiness = createDirectE2eeChannelReadiness(token);
  return {
    requests,
    result: readiness({ fetch: async (input, init) => {
      requests.push(new Request(new URL(String(input), 'https://direct.example.test'), init));
      const response = responses.shift();
      if (!response) throw new Error('missing response');
      return response;
    } }),
  };
};

const expectReadinessError = async (
  result: Promise<void>,
  failureClassification: TunnelChannelReadinessError['failureClassification'],
  retryable: boolean,
): Promise<void> => {
  try {
    await result;
    throw new Error('expected readiness failure');
  } catch (error) {
    expect(error).toBeInstanceOf(TunnelChannelReadinessError);
    const readinessError = error as TunnelChannelReadinessError;
    expect(readinessError.failureClassification).toBe(failureClassification);
    expect(readinessError.retryable).toBe(retryable);
  }
};

describe('direct E2EE tunnel client factory', () => {
  test('rejects descriptors outside the pinned production endpoint contract', () => {
    expect(() => createDirectE2eeTunnelClient({
      wssUrl: 'ws://host.example/api/openchamber/direct-e2ee/ws',
      hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    })).toThrow('Invalid direct E2EE descriptor');
  });

  test('strict health and bearer session success unlock readiness', async () => {
    const { requests, result } = runReadiness([
      json({ status: 'ok', openchamberVersion: '1.2.3' }),
      json({ authenticated: true }),
    ]);
    await result;
    expect(requests.map((request) => request.url)).toEqual([
      'https://direct.example.test/health', 'https://direct.example.test/auth/session',
    ]);
    expect(requests[1].headers.get('authorization')).toBe('Bearer secret-token');
  });

  test('health 503 is typed retryable network failure', async () => {
    const { result } = runReadiness([json({}, 503)]);
    await expectReadinessError(result, 'network', true);
  });

  test('wrong health shape is terminal protocol failure', async () => {
    const { result } = runReadiness([json({ ok: true })]);
    await expectReadinessError(result, 'protocol', false);
  });

  test('bearer 401 is terminal', async () => {
    const { result } = runReadiness([json({ status: 'ok', openchamberVersion: '1' }), json({}, 401)]);
    await expectReadinessError(result, 'terminal', false);
  });

  test('malformed session body is terminal protocol failure', async () => {
    const { result } = runReadiness([json({ status: 'ok', openchamberVersion: '1' }), json({ authenticated: false })]);
    await expectReadinessError(result, 'protocol', false);
  });

  test('readiness errors do not include the bearer token', async () => {
    const { result } = runReadiness([json({ status: 'ok', openchamberVersion: '1' }), json({}, 401)]);
    try { await result; } catch (error) {
      expect(error).toBeInstanceOf(TunnelChannelReadinessError);
      expect(String(error)).not.toContain('secret-token');
    }
  });

  test('treats direct ChannelFailure and RekeyMismatch closes as terminal', async () => {
    for (const code of [RelayCloseCode.ChannelFailure, RelayCloseCode.RekeyMismatch]) {
      const keyPair = await generateEcdhKeyPair();
      const hostEncPubJwk = await exportPublicKeyJwk(keyPair.publicKey);
      const socket: { wire: TunnelWireSocket | null } = { wire: null };
      const client = createDirectE2eeTunnelClient({
        wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
        hostEncPubJwk,
      }, null, {
        createOuterWebSocket: () => {
          socket.wire = { readyState: 1, send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
          return socket.wire;
        },
      });
      const request = client.fetch('/health');
      while (!socket.wire?.onclose) await Promise.resolve();
      socket.wire.onclose({ code, reason: 'security failure' });
      await expect(request).rejects.toThrow(`code ${code}`);
      expect(client.getStatus().state).toBe('error');
      expect(client.getStatus().failureClassification).toBe('terminal');
      client.close();
    }
  });

  test('classifies malformed direct handshake traffic as terminal protocol failure', async () => {
    const keyPair = await generateEcdhKeyPair();
    const hostEncPubJwk = await exportPublicKeyJwk(keyPair.publicKey);
    const socket: { wire: TunnelWireSocket | null } = { wire: null };
    const client = createDirectE2eeTunnelClient({
      wssUrl: 'wss://host.example/api/openchamber/direct-e2ee/ws',
      hostEncPubJwk,
    }, null, {
      createOuterWebSocket: () => {
        socket.wire = { readyState: 1, send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
        return socket.wire;
      },
    });
    const request = client.fetch('/health');
    while (!socket.wire?.onmessage) await Promise.resolve();
    socket.wire.onmessage({ data: new Uint8Array([1, 2, 3]) });
    await expect(request).rejects.toThrow();
    expect(client.getStatus().state).toBe('error');
    expect(client.getStatus().failureClassification).toBe('protocol');
    client.close();
  });
});
