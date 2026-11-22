import { describe, expect, it, vi } from 'vitest';
import { exchangeDeviceCode, startDeviceFlow } from './device-flow.js';

describe('GitHub device flow', () => {
  it('starts with redirect rejection and a bounded timeout', async () => {
    const fetch = vi.fn(async () => Response.json({
      device_code: 'provider-secret',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 300,
      interval: 5,
    }));

    await expect(startDeviceFlow({ clientId: 'client', scope: 'repo', fetch, timeoutMs: 1234 }))
      .resolves.toMatchObject({ device_code: 'provider-secret' });
    expect(fetch).toHaveBeenCalledWith('https://github.com/login/device/code', expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
      body: 'client_id=client&scope=repo',
    }));
  });

  it('rejects malformed provider grants', async () => {
    const fetch = vi.fn(async () => Response.json({ user_code: 'missing-device-code' }));

    await expect(startDeviceFlow({ clientId: 'client', scope: 'repo', fetch }))
      .rejects.toThrow('Invalid GitHub device flow response');
  });

  it('exchanges a device code for an access token', async () => {
    const fetch = vi.fn(async () => Response.json({ access_token: 'token-123', token_type: 'bearer', scope: 'repo' }));

    await expect(exchangeDeviceCode({ clientId: 'client', deviceCode: 'provider-secret', fetch }))
      .resolves.toMatchObject({ access_token: 'token-123' });
  });

  it('surfaces an in-cap error response with status and payload', async () => {
    const fetch = vi.fn(async () => Response.json(
      { error: 'bad_verification_code', error_description: 'The code passed is incorrect' },
      { status: 400 },
    ));

    const caught = await exchangeDeviceCode({ clientId: 'client', deviceCode: 'provider-secret', fetch }).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('The code passed is incorrect');
    expect(caught.status).toBe(400);
    expect(caught.payload).toMatchObject({ error: 'bad_verification_code' });
  });

  it('parses a BOM-prefixed in-cap body', async () => {
    const body = '\uFEFF' + JSON.stringify({
      device_code: 'provider-secret',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 300,
      interval: 5,
    });
    const fetch = vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }));

    await expect(startDeviceFlow({ clientId: 'client', scope: 'repo', fetch }))
      .resolves.toMatchObject({ device_code: 'provider-secret' });
  });

  it('keeps the payload=null error shape for a non-JSON in-cap body', async () => {
    const fetch = vi.fn(async () => new Response('not json', { status: 400, statusText: 'Bad Request' }));

    const caught = await exchangeDeviceCode({ clientId: 'client', deviceCode: 'provider-secret', fetch }).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('Bad Request');
    expect(caught.status).toBe(400);
    expect(caught.payload).toBeNull();
  });

  const overCapResponse = (status) => {
    const chunk = new Uint8Array(600 * 1024).fill(97);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(stream, { status, headers: { 'Content-Type': 'application/json' } });
  };

  it('throws without a payload on an over-cap 200 body', async () => {
    const fetch = vi.fn(async () => overCapResponse(200));

    const caught = await exchangeDeviceCode({ clientId: 'client', deviceCode: 'provider-secret', fetch }).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('exceeded 1048576 bytes');
    expect(caught.status).toBe(200);
    expect(caught.payload).toBeUndefined();
  });

  it('throws without a payload on an over-cap error-status body', async () => {
    const fetch = vi.fn(async () => overCapResponse(502));

    const caught = await exchangeDeviceCode({ clientId: 'client', deviceCode: 'provider-secret', fetch }).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('exceeded 1048576 bytes');
    expect(caught.status).toBe(502);
    expect(caught.payload).toBeUndefined();
  });

  it('never sends a device exchange across redirects', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'authorization_pending' }));

    await exchangeDeviceCode({ clientId: 'client', deviceCode: 'provider-secret', fetch });

    expect(fetch).toHaveBeenCalledWith('https://github.com/login/oauth/access_token', expect.objectContaining({
      redirect: 'error',
      body: expect.stringContaining('device_code=provider-secret'),
    }));
  });
});
