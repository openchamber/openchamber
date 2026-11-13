import { isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';
import { destinationFingerprint, LOOPBACK_HOSTS } from './definitions.js';
import { createOAuthAuthorization } from './oauth-authorization.js';

const REFRESH_MARGIN_MS = 60_000;
const MAX_METADATA_BYTES = 256 * 1024;

const authorizationRequired = () => new ProtectedMcpError('authorization_required', { status: 409 });

const safeUrl = (value) => {
  if (!isString(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return url;
  } catch {
    // Not a URL.
  }
  return null;
};

/**
 * OAuth 2.1 for remote MCP servers, run inside the service: discovery,
 * optional dynamic client registration, authorization code with PKCE and the
 * `resource` parameter, refresh with rotation persisted before use, and
 * revocation. Tokens live in the connection's credentials and never leave.
 */
export function createOAuth({ store, fetchImpl = fetch, now = Date.now, log = () => {} }) {
  const refreshing = new Map();

  const getJson = async (url, init = {}) => {
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) throw new ProtectedMcpError('oauth_response_too_large', { status: 502 });
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };

  const firstMetadata = async (candidates) => {
    for (const candidate of candidates) {
      try {
        const { status, body } = await getJson(candidate, { headers: { accept: 'application/json' } });
        if (status === 200 && isPlainObject(body)) return body;
      } catch {
        // Try the next well-known location.
      }
    }
    return null;
  };

  const discover = async (definition) => {
    const resource = new URL(definition.http.url);
    let issuer = definition.http.oauth.issuer ?? null;
    if (!issuer) {
      const resourcePath = resource.pathname === '/' ? '' : resource.pathname;
      const metadata = await firstMetadata([
        `${resource.origin}/.well-known/oauth-protected-resource${resourcePath}`,
        `${resource.origin}/.well-known/oauth-protected-resource`,
      ]);
      issuer = Array.isArray(metadata?.authorization_servers) ? metadata.authorization_servers[0] : null;
    }
    const issuerUrl = safeUrl(issuer);
    if (!issuerUrl) throw new ProtectedMcpError('oauth_discovery_failed', { status: 502 });
    const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/$/, '');
    const metadata = await firstMetadata([
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
    ]);
    const authorizationEndpoint = safeUrl(metadata?.authorization_endpoint);
    const tokenEndpoint = safeUrl(metadata?.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) throw new ProtectedMcpError('oauth_discovery_failed', { status: 502 });
    return {
      issuer: issuerUrl.href,
      authorizationEndpoint: authorizationEndpoint.href,
      tokenEndpoint: tokenEndpoint.href,
      revocationEndpoint: safeUrl(metadata.revocation_endpoint)?.href ?? null,
      registrationEndpoint: safeUrl(metadata.registration_endpoint)?.href ?? null,
    };
  };

  const clientFor = async (definition, server, redirectUri) => {
    if (definition.http.oauth.clientId) return { clientId: definition.http.oauth.clientId, clientSecret: null, redirectUri };
    if (!server.registrationEndpoint) throw new ProtectedMcpError('oauth_client_required', { status: 400 });
    const { status, body } = await getJson(server.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'OpenChamber protected MCP',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if ((status !== 200 && status !== 201) || !isString(body?.client_id)) throw new ProtectedMcpError('oauth_registration_failed', { status: 502 });
    return { clientId: body.client_id, clientSecret: isString(body.client_secret) ? body.client_secret : null, redirectUri };
  };

  /** Client credentials for the token endpoint: a configured secret slot, a registered secret, or none. */
  const clientAuthentication = (definition, credentials, form) => {
    const record = credentials.oauth;
    const configured = definition.http.oauth.clientSecret
      ? credentials.secrets[definition.http.oauth.clientSecret.secret]
      : null;
    const secret = configured ?? record.client.clientSecret;
    form.set('client_id', record.client.clientId);
    if (!secret) return {};
    return { authorization: `Basic ${Buffer.from(`${encodeURIComponent(record.client.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}` };
  };

  const tokenRequest = async (definition, record, form) => {
    const credentials = { secrets: store.credentialsFor(definition)?.secrets ?? {}, oauth: record };
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...clientAuthentication(definition, credentials, form) };
    return getJson(record.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
  };

  const tokensFrom = (body, previous) => {
    if (!isString(body?.access_token) || (body.token_type && String(body.token_type).toLowerCase() !== 'bearer')) return null;
    return {
      accessToken: body.access_token,
      refreshToken: isString(body.refresh_token) ? body.refresh_token : previous?.refreshToken ?? null,
      expiresAt: Number.isFinite(body.expires_in) ? now() + body.expires_in * 1000 : null,
      scope: isString(body.scope) ? body.scope : previous?.scope ?? null,
    };
  };

  /**
   * Forgets the stored grant, only while it is still `tokens`, the one a
   * request used. A token object is replaced on every change and never
   * modified, so identity tells grants apart even when an authorization server
   * hands out the same refresh token again: the refusal of an old grant never
   * erases one authorized meanwhile.
   */
  const markUnauthorized = async (definition, { tokens }) => {
    await store.updateOAuth(definition.id, destinationFingerprint(definition), (previous) => ({ ...previous, tokens: null }), {
      expect: (current) => current?.tokens === tokens,
    });
  };

  /** The grant stored now, for a request whose own write lost a race. */
  const currentTokens = (definition) => {
    const latest = store.credentialsFor(definition)?.oauth?.tokens;
    if (latest?.accessToken) return latest;
    throw authorizationRequired();
  };

  const refresh = async (definition, record) => {
    const grant = record.tokens;
    if (!grant.refreshToken) {
      await markUnauthorized(definition, { tokens: grant });
      return currentTokens(definition);
    }
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, resource: definition.http.url });
    let answer;
    try {
      answer = await tokenRequest(definition, record, form);
    } catch {
      throw new ProtectedMcpError('oauth_refresh_failed', { status: 502 });
    }
    const tokens = answer.status === 200 ? tokensFrom(answer.body, grant) : null;
    if (!tokens) {
      if (answer.status === 400 || answer.status === 401) {
        log('oauth_refresh_rejected', { connection: definition.id });
        await markUnauthorized(definition, { tokens: grant });
        return currentTokens(definition);
      }
      throw new ProtectedMcpError('oauth_refresh_failed', { status: 502 });
    }
    // The rotated refresh token is stored before the new access token is used,
    // and only over the grant this refresh started from: after a revocation or
    // a new authorization the answer is dropped.
    const saved = await store.updateOAuth(definition.id, destinationFingerprint(definition), (previous) => ({ ...previous, tokens }), {
      expect: (current) => current?.tokens === grant,
    });
    if (!saved) return currentTokens(definition);
    return tokens;
  };

  return {
    ...createOAuthAuthorization({ store, now, discover, clientFor, tokenRequest, tokensFrom, log }),

    /**
     * The grant to send now, refreshed when it is about to expire or when the
     * upstream refused it. A request hands it back to `markUnauthorized`.
     */
    async tokensFor(definition, { refresh: force = false } = {}) {
      const record = store.credentialsFor(definition)?.oauth;
      if (!record?.tokens) throw authorizationRequired();
      const fresh = record.tokens.expiresAt === null || record.tokens.expiresAt - now() > REFRESH_MARGIN_MS;
      if (fresh && !force) return record.tokens;
      const running = refreshing.get(definition.id);
      if (running) return running;
      const work = refresh(definition, record).finally(() => refreshing.delete(definition.id));
      refreshing.set(definition.id, work);
      return work;
    },

    markUnauthorized,

    /** Tells the authorization server to forget the tokens; local deletion does not wait on it. */
    async revokeUpstream(definition, credentials) {
      const record = credentials?.oauth;
      if (!record?.revocationEndpoint || !record.tokens) return;
      for (const [token, hint] of [[record.tokens.refreshToken, 'refresh_token'], [record.tokens.accessToken, 'access_token']]) {
        if (!token) continue;
        const form = new URLSearchParams({ token, token_type_hint: hint });
        const { status } = await getJson(record.revocationEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...clientAuthentication(definition, credentials, form) },
          body: form.toString(),
        });
        if (status < 200 || status >= 300) log('oauth_revocation_failed', { connection: definition.id, code: 'oauth_revocation_rejected', status });
      }
    },
  };
}
