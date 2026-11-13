import { createHash, randomBytes } from 'node:crypto';
import { ProtectedMcpError } from './contract.js';
import { destinationFingerprint } from './definitions.js';
import { parseRedirectUri } from './oauth-redirect.js';

const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 16;
const random = (bytes) => randomBytes(bytes).toString('base64url');

/** Owns single-use browser states and observable, expiring sign-in attempts. */
export function createOAuthAuthorization({ store, now, discover, clientFor, tokenRequest, tokensFrom, log }) {
  const pending = new Map();
  const attempts = new Map();
  const expire = () => {
    for (const [state, entry] of pending) if (entry.expires <= now()) pending.delete(state);
    for (const [attempt, entry] of attempts) if (entry.expires <= now()) attempts.delete(attempt);
  };
  return {
    async start({ id, expectedRevision, redirectUri: supplied }) {
      const callerUri = parseRedirectUri(supplied);
      const definition = store.get(id);
      if (!definition) throw new ProtectedMcpError('connection_not_found', { status: 404 });
      if (definition.revision !== expectedRevision) throw new ProtectedMcpError('revision_conflict', { status: 409 });
      if (definition.transport !== 'http' || !definition.http.oauth) throw new ProtectedMcpError('oauth_not_configured');
      const redirectUri = definition.http.oauth.redirectUri ?? callerUri;
      const generation = store.credentialsFor(definition)?.oauth?.generation ?? 0;
      const server = await discover(definition);
      const client = await clientFor(definition, server, redirectUri);
      expire();
      if (pending.size >= MAX_PENDING) {
        const state = pending.keys().next().value;
        const evicted = pending.get(state);
        pending.delete(state);
        attempts.set(evicted.attempt, { status: 'done', outcome: 'oauth_state_invalid', expires: evicted.expires });
      }
      const verifier = random(32);
      const state = random(32);
      const attempt = random(16);
      const expires = now() + PENDING_MS;
      pending.set(state, { attempt, id, revision: definition.revision, fingerprint: destinationFingerprint(definition), verifier, redirectUri, server, client, generation, expires });
      attempts.set(attempt, { status: 'pending', expires });
      const url = new URL(server.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (definition.http.oauth.scopes.length > 0) url.searchParams.set('scope', definition.http.oauth.scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('resource', definition.http.url);
      return { attempt, url: url.href };
    },

    async complete({ state, code, error }) {
      expire();
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry) return { outcome: 'oauth_state_invalid', name: null };
      const definition = store.get(entry.id);
      const name = definition?.name ?? null;
      const finish = (outcome) => {
        if (entry.expires > now()) attempts.set(entry.attempt, { status: 'done', outcome, expires: entry.expires });
        return { outcome, name };
      };
      if (error !== undefined) return finish('oauth_denied');
      if (!definition || definition.revision !== entry.revision || destinationFingerprint(definition) !== entry.fingerprint) return finish('oauth_connection_changed');
      if (!code) return finish('oauth_state_invalid');
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier, resource: definition.http.url });
      let answer;
      try {
        answer = await tokenRequest(definition, { ...entry.server, client: entry.client }, form);
      } catch {
        return finish('oauth_exchange_failed');
      }
      const tokens = answer.status === 200 ? tokensFrom(answer.body, null) : null;
      if (!tokens) return finish('oauth_exchange_failed');
      // Start never writes a registration over another flow's client or grant.
      const saved = await store.updateOAuth(definition.id, entry.fingerprint, (previous) => ({ ...previous, ...entry.server, client: entry.client, tokens, generation: entry.generation + 1 }), {
        restart: true,
        expect: (current, latest) => latest.revision === entry.revision && (current?.generation ?? 0) === entry.generation,
      });
      if (saved) log('oauth_authorized', { connection: definition.id });
      return finish(saved ? 'authorized' : 'oauth_connection_changed');
    },

    attempt(id) {
      expire();
      const entry = attempts.get(id);
      if (!entry) return { status: 'unknown' };
      return entry.status === 'pending' ? { status: 'pending' } : { status: 'done', outcome: entry.outcome };
    },
  };
}
