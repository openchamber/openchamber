import { describe, expect, test } from 'bun:test';
import { readPairingResponse } from './pairingResponse';

describe('pairing response', () => {
  test('reads the token from a successful redemption', async () => {
    expect(await readPairingResponse(Response.json({ clientToken: ' test-token ', ok: true })))
      .toEqual({ kind: 'success', token: 'test-token' });
  });

  test('recognizes the server rejection for expired, used, or invalid links', async () => {
    expect(await readPairingResponse(Response.json({ error: 'Invalid or expired pairing session' }, { status: 400 })))
      .toEqual({ kind: 'rejected' });
  });

  test('does not mistake rate limiting for an expired link with the same error body', async () => {
    expect(await readPairingResponse(Response.json({ error: 'Invalid or expired pairing session' }, { status: 429 })))
      .toEqual({ kind: 'http-error', status: 429 });
  });

  test('preserves HTTP failures even when the body is not JSON', async () => {
    for (const status of [400, 401, 403, 404, 500, 502]) {
      expect(await readPairingResponse(new Response('Upstream error', { status })))
        .toEqual({ kind: 'http-error', status });
    }
  });

  test('does not accept a token carried by an unsuccessful response', async () => {
    expect(await readPairingResponse(Response.json({ clientToken: 'test-token' }, { status: 403 })))
      .toEqual({ kind: 'http-error', status: 403 });
  });

  test('distinguishes malformed successful responses from network failures', async () => {
    for (const body of [null, {}, { clientToken: '' }, { clientToken: ' ' }, { clientToken: 42 }]) {
      expect(await readPairingResponse(Response.json(body))).toEqual({ kind: 'invalid-response' });
    }
    expect(await readPairingResponse(new Response('<html>Wrong service</html>')))
      .toEqual({ kind: 'invalid-response' });
  });
});
