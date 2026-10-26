import { describe, expect, test } from 'bun:test';

import { parseGuestRequestProxyResponse } from './oauth.ts';

const jsonResponse = (status: number, body: string): Response => (
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
);

describe('parseGuestRequestProxyResponse', () => {
  test('keeps a successful payload', async () => {
    expect(await parseGuestRequestProxyResponse(jsonResponse(200, '{"status":200,"body":"{\\"ok\\":true}"}'))).toEqual({
      ok: true,
      result: { status: 200, body: '{"ok":true}' },
    });
  });

  test('forwards DISCONNECTED, BAD_PATH, and NO_INTEGRATION', async () => {
    expect(await parseGuestRequestProxyResponse(jsonResponse(409, '{"error":"DISCONNECTED","message":"Not connected."}'))).toEqual({
      ok: false,
      code: 'DISCONNECTED',
      message: 'Not connected.',
    });
    expect(await parseGuestRequestProxyResponse(jsonResponse(400, '{"error":"BAD_PATH","message":"Request path must stay on the declared apiOrigin."}'))).toEqual({
      ok: false,
      code: 'BAD_PATH',
      message: 'Request path must stay on the declared apiOrigin.',
    });
    expect(await parseGuestRequestProxyResponse(jsonResponse(400, '{"error":"NO_INTEGRATION","message":"This guest does not declare an API origin."}'))).toEqual({
      ok: false,
      code: 'NO_INTEGRATION',
      message: 'This guest does not declare an API origin.',
    });
  });

  test('unknown or empty failure bodies become HOST_REJECTED', async () => {
    expect(await parseGuestRequestProxyResponse(jsonResponse(400, '{"error":"TOKEN_INVALID","message":"That API token was refused."}'))).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      message: 'That API token was refused.',
    });
    expect(await parseGuestRequestProxyResponse(new Response('not-json', { status: 500 }))).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      message: 'Request failed.',
    });
    expect(await parseGuestRequestProxyResponse(jsonResponse(200, '{"status":200}'))).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      message: 'Request failed.',
    });
  });
});
