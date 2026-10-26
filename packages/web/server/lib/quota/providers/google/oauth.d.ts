export type GoogleOAuthRefreshFailure = {
  ok: false;
  status: number | null;
  error: 'unauthorized_client' | 'invalid_grant' | 'invalid_client' | 'http' | 'network' | 'timeout' | 'invalid_response';
};

export type GoogleOAuthRefreshResult = { ok: true; accessToken: string } | GoogleOAuthRefreshFailure;

export function refreshGoogleAccessToken(
  refreshToken: string,
  client: 'gemini' | 'antigravity',
  options?: { fallbackToAntigravity?: boolean },
): Promise<GoogleOAuthRefreshResult>;
