import crypto from 'node:crypto';

import { createPkcePair, exchangeAuthorizationCode, postTokenForm } from '../guests/oauth.js';


const PENDING_TTL_MS = 10 * 60_000;

export const trackerRedirectUri = (origin, providerId) => `${origin.replace(/\/+$/, '')}/api/tracker/${encodeURIComponent(providerId)}/oauth/callback`;

export const resolveOAuthEndpoint = (value, instance) => (value.startsWith('/') ? new URL(value, instance).toString() : value);

export const oauthTargetOf = ({ authorizeUrl, tokenUrl }, instance) => ({
  authorizeUrl: resolveOAuthEndpoint(authorizeUrl, instance),
  tokenUrl: resolveOAuthEndpoint(tokenUrl, instance),
});

/**
 * @param {{ now?: () => number }} [options]
 */
export const createTrackerOAuth = ({ now = Date.now } = {}) => {
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
    start: ({ providerId, instance, client, target, scopes, redirectUri, connection }) => {
      prune();
      dropProvider(providerId);
      const { verifier, challenge } = createPkcePair();
      const state = crypto.randomBytes(32).toString('base64url');
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

    take: ({ providerId, state }) => {
      prune();
      const trimmed = typeof state === 'string' ? state.trim() : '';
      const pending = trimmed ? pendingByState.get(trimmed) : undefined;
      if (!pending || pending.providerId !== providerId) return null;
      pendingByState.delete(trimmed);
      if (pendingByProvider.get(providerId) === trimmed) pendingByProvider.delete(providerId);
      return pending;
    },

    dropProvider,

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

    refresh: ({ tokenUrl, refreshToken, client }) => postTokenForm(tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.id,
      client_secret: client.secret,
    }),
  });
};
