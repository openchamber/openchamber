import crypto from 'node:crypto';

import { createPkcePair, exchangeAuthorizationCode, postTokenForm } from '../guests/oauth.js';

/**
 * The browser sign-in of an extension tracker, run by OpenChamber with PKCE
 * (S256), the way a guest integration's is (`../guests/oauth.js`): the user
 * saves the client on the card, clicks Connect, signs in at the tracker's
 * authorize endpoint, and the tracker redirects to
 * `/api/tracker/ext-<id>/oauth/callback` with a `state` only this process
 * knows. A callback without a matching state is refused, since accepting one
 * would let any link visited during the pending window attach a stranger's
 * account. The exchange goes to the endpoints the user saw when they clicked
 * Connect, resolved against the instance they connect to, and only while the
 * package still names the same ones.
 */

const PENDING_TTL_MS = 10 * 60_000;

/** The callback a tracker redirects to; the card shows it for the app registration. */
export const trackerRedirectUri = (origin, providerId) => `${origin.replace(/\/+$/, '')}/api/tracker/${encodeURIComponent(providerId)}/oauth/callback`;

/**
 * An OAuth endpoint as the manifest names it: an https URL, or a path on the
 * instance for a tracker whose server the user names. Resolved once, when the
 * sign-in starts, and recorded with the tokens as their target.
 */
export const resolveOAuthEndpoint = (value, instance) => (value.startsWith('/') ? new URL(value, instance).toString() : value);

export const oauthTargetOf = ({ authorizeUrl, tokenUrl }, instance) => ({
  authorizeUrl: resolveOAuthEndpoint(authorizeUrl, instance),
  tokenUrl: resolveOAuthEndpoint(tokenUrl, instance),
});

/**
 * @param {{ now?: () => number }} [options]
 */
export const createTrackerOAuth = ({ now = Date.now } = {}) => {
  /** state → pending sign-in; one per provider, the newest. */
  const pendingByState = new Map();
  const pendingByProvider = new Map();

  const prune = () => {
    for (const [state, pending] of pendingByState) {
      if (pending.expiresAt > now()) continue;
      pendingByState.delete(state);
      if (pendingByProvider.get(pending.providerId) === state) pendingByProvider.delete(pending.providerId);
    }
  };

  const dropProvider = (providerId) => {
    const state = pendingByProvider.get(providerId);
    if (state) pendingByState.delete(state);
    pendingByProvider.delete(providerId);
  };

  return Object.freeze({
    /**
     * Starts a sign-in: remembers the verifier, the redirect URI, the client
     * and the resolved endpoints under a fresh state, and answers the
     * authorize URL to open. A second start for the provider replaces the first.
     */
    start: ({ providerId, instance, client, target, scopes, redirectUri, connection }) => {
      prune();
      dropProvider(providerId);
      const { verifier, challenge } = createPkcePair();
      const state = crypto.randomBytes(32).toString('base64url');
      // `connection` is the account store's identity for this connect; the callback commits under it.
      pendingByState.set(state, { providerId, instance, client, target, redirectUri, verifier, connection, expiresAt: now() + PENDING_TTL_MS });
      pendingByProvider.set(providerId, state);
      const url = new URL(target.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.id);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
      return { authorizationUrl: url.toString(), expiresIn: Math.floor(PENDING_TTL_MS / 1000) };
    },

    /** The pending sign-in a callback names, taken once; null for a state this provider did not issue or that expired. */
    take: ({ providerId, state }) => {
      prune();
      const trimmed = typeof state === 'string' ? state.trim() : '';
      const pending = trimmed ? pendingByState.get(trimmed) : undefined;
      if (!pending || pending.providerId !== providerId) return null;
      pendingByState.delete(trimmed);
      if (pendingByProvider.get(providerId) === trimmed) pendingByProvider.delete(providerId);
      return pending;
    },

    /** Forgets a provider's pending sign-in (it was paused, removed or disconnected). */
    dropProvider,

    /** The code exchange, at the pending sign-in's token endpoint. Answers `{ accessToken, refreshToken, tokenType, expiresAt }`. */
    exchange: (pending, code) => exchangeAuthorizationCode(
      pending.target.tokenUrl,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.client.id,
        client_secret: pending.client.secret,
        code_verifier: pending.verifier,
      },
      { client_id: pending.client.id, client_secret: pending.client.secret, code },
    ),

    /** A refresh, at the endpoint the tokens were minted for. */
    refresh: ({ tokenUrl, refreshToken, client }) => postTokenForm(tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.id,
      client_secret: client.secret,
    }),
  });
};
