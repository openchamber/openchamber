import { z } from 'zod';

// Installed-app clients already used by the Gemini and Antigravity providers.
// Keeping these in git is fine: for an installed application Google expects
// the client ID and secret to be embedded in the source, and "the client
// secret is obviously not treated as a secret"
// (https://developers.google.com/identity/protocols/oauth2#installed).
const CLIENTS = {
  gemini: {
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: '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',
  },
  antigravity: {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
  },
};

const tokenResponse = z.object({ access_token: z.string().trim().min(1) });
const oauthError = z.object({ error: z.enum(['unauthorized_client', 'invalid_grant', 'invalid_client']) });

const exchange = async (refreshToken, client) => {
  let status = null;
  const signal = AbortSignal.timeout(15000);
  try {
    const { clientId, clientSecret } = CLIENTS[client];
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      redirect: 'error',
      signal,
    });
    status = response.status;
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { ok: false, status, error: response.ok ? 'invalid_response' : 'http' };
      }
      throw error;
    }
    if (!response.ok) {
      return { ok: false, status, error: oauthError.safeParse(data).data?.error ?? 'http' };
    }
    const token = tokenResponse.safeParse(data);
    if (!token.success) return { ok: false, status, error: 'invalid_response' };
    return { ok: true, accessToken: token.data.access_token };
  } catch (error) {
    return { ok: false, status, error: signal.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
};

export const refreshGoogleAccessToken = async (refreshToken, client, { fallbackToAntigravity = false } = {}) => {
  const result = await exchange(refreshToken, client);
  // Both plugins pack project context with pipes. The credential has no reliable
  // client marker; probe the other known client only on this specific rejection.
  if (!result.ok && client === 'gemini' && fallbackToAntigravity
    && (result.status === 400 || result.status === 401) && result.error === 'unauthorized_client') {
    return exchange(refreshToken, 'antigravity');
  }
  return result;
};
