/**
 * Keeps the host's browser login fresh for the spaces that hold it, since 7b.
 *
 * A login grant puts the host's short OpenAI token into a space's gatekeeper and nothing
 * else: the space never refreshes, the refresh token stays on the host. OpenCode on the host
 * refreshes that login only when the user prompts it within five minutes of the token's end,
 * so a user who leaves the agent alone would see the space stop after an hour. The keeper
 * reads the host's login once a minute while a running space holds it, renews it itself ten
 * minutes before its end with the refresh token, through `renewStoredLogin` of
 * `opencode/auth.js`, which puts the new login into the host's OpenCode, and says the token
 * to the gatekeeper of every such space again whenever it changed, whoever changed it.
 *
 * `exchangeOpenAILogin` is what OpenCode's own plugins send to the issuer for each login
 * method, at v2.0.25: `packages/core/src/plugin/provider/chatgpt.ts` for "Sign in with ChatGPT"
 * and `openai.ts` for the two legacy Codex logins. A new method is refused, so a login the
 * host cannot renew is never left to fail inside without a word. Copilot's GitHub token has no
 * end (7d), so the keeper only says it again when it changed.
 */

import crypto from 'node:crypto';

import { z } from 'zod';

import { loginEndOf, loginEnded } from './space-opencode.js';

const ISSUER = 'https://auth.openai.com';
// The legacy Codex logins are made with OpenAI's own app client, as OpenCode's `openai.ts` has it.
const LEGACY_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_SHARING_RESOURCE = 'https://api.openai.com/v1';
const TOKEN_SHARING_METHOD = 'chatgpt-token-sharing';
const LEGACY_METHODS = new Set(['chatgpt-browser', 'chatgpt-headless']);
const DEFAULT_LIFETIME_S = 3600;
const EXCHANGE_TIMEOUT_MS = 30_000;
const MAX_ANSWER_BYTES = 64 * 1024;

// The token is renewed this long before its end. OpenCode on the host renews at five minutes,
// so the two seldom try at once, and the row is read again before the host writes its own.
export const RENEW_WINDOW_MS = 10 * 60_000;
/** How often the keeper looks at the host's login while a running space holds it. */
export const KEEP_INTERVAL_MS = 60_000;

const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  id_token: z.string().optional(),
  scope: z.string().optional(),
});
const tokenSharingMetadataSchema = z.object({ clientID: z.string().min(1), scopes: z.array(z.string()).optional() });
// What the legacy Codex login reads out of its tokens for the account id, as `openai.ts` does.
const claimsSchema = z.object({
  chatgpt_account_id: z.string().optional(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().optional() }).optional(),
  organizations: z.array(z.object({ id: z.string() })).optional(),
});

const accountIdOf = (token) => {
  const part = token?.split('.')[1];
  if (!part) return undefined;
  let claims;
  try {
    claims = claimsSchema.safeParse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
  } catch {
    return undefined;
  }
  if (!claims.success) return undefined;
  return claims.data.chatgpt_account_id ?? claims.data['https://api.openai.com/auth']?.chatgpt_account_id ?? claims.data.organizations?.[0]?.id;
};

/** What the issuer is asked for a login's method, or null for a method the keeper does not know. */
export function exchangeRequestOf(login) {
  if (login.methodID === TOKEN_SHARING_METHOD) {
    const metadata = tokenSharingMetadataSchema.safeParse(login.metadata);
    if (!metadata.success) return null;
    return {
      url: `${ISSUER}/api/accounts/oauth/token`,
      body: { grant_type: 'refresh_token', client_id: metadata.data.clientID, refresh_token: login.refresh, resource: TOKEN_SHARING_RESOURCE },
    };
  }
  if (LEGACY_METHODS.has(login.methodID)) {
    return { url: `${ISSUER}/oauth/token`, body: { grant_type: 'refresh_token', refresh_token: login.refresh, client_id: LEGACY_CLIENT_ID } };
  }
  return null;
}

/** The new login a method's answer makes, with the metadata that method keeps, as OpenCode's plugins build it. */
export function exchangedLoginOf(login, answer, now) {
  const value = { access: answer.access_token, refresh: answer.refresh_token, expires: now + (answer.expires_in ?? DEFAULT_LIFETIME_S) * 1000 };
  if (login.methodID === TOKEN_SHARING_METHOD) {
    const metadata = tokenSharingMetadataSchema.parse(login.metadata);
    const scopes = answer.scope?.split(' ').filter(Boolean) ?? metadata.scopes ?? [];
    return { ...value, metadata: { clientID: metadata.clientID, scopes } };
  }
  const accountID = accountIdOf(answer.id_token) ?? accountIdOf(answer.access_token);
  return { ...value, metadata: accountID ? { accountID } : login.metadata };
}

/**
 * Asks the issuer for new tokens with a login's refresh token, the way OpenCode does for that
 * login's method. `fetch` and `now` are injectable for the tests; nothing of the answer is
 * logged, and a body over 64 KiB or one that is not the token answer is an error.
 */
export function createLoginExchange({ fetch = globalThis.fetch, now = Date.now, userAgent = 'OpenChamber' } = {}) {
  return async (login) => {
    const request = exchangeRequestOf(login);
    if (!request) throw new Error(`The ${login.methodID} login cannot be renewed by OpenChamber`);
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent, accept: 'application/json' },
      body: new URLSearchParams(request.body).toString(),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error = new Error(`The login issuer answered ${response.status}`);
      // A refusal is the issuer's answer about this login, after a sign-out or a revocation, and
      // asking again with the same tokens changes nothing; anything else may pass next time.
      if (response.status >= 400 && response.status < 500) error.code = 'login_refused';
      throw error;
    }
    const text = await response.text();
    if (text.length > MAX_ANSWER_BYTES) throw new Error('The login issuer answered with too large a body');
    let parsed;
    try {
      parsed = tokenAnswerSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) throw new Error('The login issuer did not answer with tokens');
    return exchangedLoginOf(login, parsed.data, now());
  };
}

/**
 * `readLogin(provider)` reads the host's login as `getStoredLogin` does, `renewLogin(provider,
 * exchange)` replaces it as `renewStoredLogin` does, and `exchange` is the issuer request above.
 * `holders()` answers `{ spaceId, grant }` for every login grant of a running space, and
 * `say(spaceId, grant, login)` tells that space's gatekeeper the login: true when it did, false
 * when the gatekeeper refused, null when an action holds the space.
 */
export function createLoginKeeper({ readLogin, renewLogin, exchange, holders, say, now = Date.now, logger = console }) {
  // One renewal per provider at a time; callers that arrive during it share its answer.
  const renewing = new Map();
  // The `expires` of the login whose renewal the issuer refused, by provider: it is not asked
  // again for the same login, once a minute for as long as a space holds it, but only when the
  // host's login changed, after the user signed in again. A failure that is not the issuer's
  // refusal, the network, a timeout, an issuer that is down, a write that failed, is tried
  // again on the next look.
  const refused = new Map();
  // A fingerprint of the login each space's gatekeeper was last told, by space and grant id, so
  // a tick says a login again only when its token changed, whoever changed it. A hash, not the
  // token: the keeper holds no token between looks. Not `expires`, because Copilot's token has
  // none and still changes when the user signs in to GitHub again.
  const said = new Map();
  const fingerprintOf = (login) => crypto.createHash('sha256').update(login.access).digest('hex');

  const renew = (provider) => {
    if (!renewing.has(provider)) {
      renewing.set(provider, renewLogin(provider, exchange).finally(() => { renewing.delete(provider); }));
    }
    return renewing.get(provider);
  };

  /**
   * The host's login for a provider as it is now, renewed first when it ends within the window
   * or has ended, or null when the host has none. A renewal that fails is logged and answers
   * the login as it is: one that still has time keeps a turn under way inside from being cut
   * short, and one that has ended is the journey's to refuse, `login_expired` for a grant and
   * "needs access" for a start. A token with no end, Copilot's, is answered as it is: there is
   * nothing to renew.
   */
  const fresh = async (provider) => {
    const login = await readLogin(provider);
    if (!login) return null;
    const end = loginEndOf(provider, login);
    if (end === null || end > now() + RENEW_WINDOW_MS) return login;
    if (refused.get(provider) === login.expires) return login;
    try {
      const renewed = await renew(provider);
      refused.delete(provider);
      return renewed;
    } catch (error) {
      if (error?.code === 'login_refused') refused.set(provider, login.expires);
      logger.warn?.(`[spaces] the ${provider} login on this computer could not be renewed: ${error?.code ?? error?.message ?? error}`);
      return login;
    }
  };

  /** One look at the host's login for every running space that holds it; failures are logged and never thrown. */
  const tick = async () => {
    let holding;
    try {
      holding = await holders();
    } catch (error) {
      logger.warn?.(`[spaces] could not tell which spaces hold a login: ${error?.code ?? error?.message ?? error}`);
      return;
    }
    const logins = new Map();
    for (const { spaceId, grant } of holding) {
      if (!logins.has(grant.provider)) {
        logins.set(grant.provider, await fresh(grant.provider).catch((error) => {
          logger.warn?.(`[spaces] the ${grant.provider} login on this computer could not be read: ${error?.code ?? error?.message ?? error}`);
          return null;
        }));
      }
      const login = logins.get(grant.provider);
      // A host that is signed out, signed in another way, or whose login has ended and could not
      // be renewed, is what the list shows as "needs access"; the keeper has nothing to say.
      if (!login || login.methodID !== grant.method || loginEnded(grant.provider, login, now())) continue;
      const fingerprint = fingerprintOf(login);
      if (said.get(spaceId)?.get(grant.id) === fingerprint) continue;
      // A space with an action under way is asked again on the next look; a gatekeeper that
      // refused is not, for the same token: a start says the login again when it comes back.
      if ((await say(spaceId, grant, login)) === null) continue;
      if (!said.has(spaceId)) said.set(spaceId, new Map());
      said.get(spaceId).set(grant.id, fingerprint);
    }
    const stillHolding = new Set(holding.map(({ spaceId }) => spaceId));
    for (const spaceId of said.keys()) if (!stillHolding.has(spaceId)) said.delete(spaceId);
  };

  return { fresh, tick };
}
