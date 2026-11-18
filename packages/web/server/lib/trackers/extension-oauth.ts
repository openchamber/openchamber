import crypto from 'node:crypto';

import { createPkcePair, exchangeAuthorizationCode, postTokenForm } from '../guests/oauth.js';


const PENDING_TTL_MS = 10 * 60_000;

export type TrackerOAuthTarget = { authorizeUrl: string; tokenUrl: string };
export type TrackerOAuthClient = { id: string; secret?: string };
type AuthorizationStart = {
  providerId: string;
  instance: string;
  client: TrackerOAuthClient;
  target: TrackerOAuthTarget;
  scopes: string[];
  redirectUri: string;
  connection: symbol;
};
type PendingAuthorization = Omit<AuthorizationStart, 'scopes'> & { verifier: string; expiresAt: number };
const isStateText = (value: unknown): value is string => typeof value === 'string';

export const trackerRedirectUri = (origin: string, providerId: string) => `${origin.replace(/\/+$/, '')}/api/tracker/${encodeURIComponent(providerId)}/oauth/callback`;

export const resolveOAuthEndpoint = (value: string, instance: string) => (value.startsWith('/') ? new URL(value, instance).toString() : value);

export const oauthTargetOf = ({ authorizeUrl, tokenUrl }: TrackerOAuthTarget, instance: string) => ({
  authorizeUrl: resolveOAuthEndpoint(authorizeUrl, instance),
  tokenUrl: resolveOAuthEndpoint(tokenUrl, instance),
});

export const createTrackerOAuth = ({ now = Date.now }: { now?: () => number } = {}) => {
  const pendingByState = new Map<string, PendingAuthorization>();
  const pendingByProvider = new Map<string, string>();

  const prune = () => {
    for (const [state, pending] of pendingByState) {
      if (pending.expiresAt > now()) continue;
      pendingByState.delete(state);
      if (pendingByProvider.get(pending.providerId) === state) pendingByProvider.delete(pending.providerId);
    }
  };

  const dropProvider = (providerId: string) => {
    const state = pendingByProvider.get(providerId);
    if (state) pendingByState.delete(state);
    pendingByProvider.delete(providerId);
  };

  return Object.freeze({
    start: ({ providerId, instance, client, target, scopes, redirectUri, connection }: AuthorizationStart) => {
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

    take: ({ providerId, state }: { providerId: string; state: string }) => {
      prune();
      const trimmed = isStateText(state) ? state.trim() : '';
      const pending = trimmed ? pendingByState.get(trimmed) : undefined;
      if (!pending || pending.providerId !== providerId) return null;
      pendingByState.delete(trimmed);
      if (pendingByProvider.get(providerId) === trimmed) pendingByProvider.delete(providerId);
      return pending;
    },

    dropProvider,

    exchange: (pending: Pick<PendingAuthorization, 'target' | 'redirectUri' | 'client' | 'verifier'>, code: string) => exchangeAuthorizationCode(
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

    refresh: ({ tokenUrl, refreshToken, client }: { tokenUrl: string; refreshToken: string; client: TrackerOAuthClient }) => postTokenForm(tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.id,
      client_secret: client.secret,
    }),
  });
};
