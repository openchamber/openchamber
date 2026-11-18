
import crypto from 'node:crypto';

import { z } from 'zod';

import { loginEndOf, loginEnded } from './space-opencode.js';
import type { StoredLogin, renewStoredLogin } from '../opencode/auth.js';
import type { SpaceGrant } from './space-records.js';
import { failureProperty } from './failure.js';
import { transferValue } from './code-transfer.js';
import type { createSpaceJourney } from './journey.js';

type Exchange = Parameters<typeof renewStoredLogin>[1];
type ExchangeLogin = Parameters<Exchange>[0];
type LoginGrant = Extract<SpaceGrant, { kind: 'login' }>;
export interface LoginKeeperOptions {
  readLogin: (provider: string) => Promise<StoredLogin | null>;
  renewLogin: typeof renewStoredLogin;
  exchange: Exchange;
  holders: () => Promise<{ spaceId: string; grant: LoginGrant }[]>;
  say: ReturnType<typeof createSpaceJourney>['sayLogin'];
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}
export interface LoginExchangeOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  userAgent?: string;
}
const errorSummary = <Cause>(error: Cause) => failureProperty(error, 'code') ?? failureProperty(error, 'message') ?? error;

const ISSUER = 'https://auth.openai.com';
const LEGACY_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_SHARING_RESOURCE = 'https://api.openai.com/v1';
const TOKEN_SHARING_METHOD = 'chatgpt-token-sharing';
const LEGACY_METHODS = new Set(['chatgpt-browser', 'chatgpt-headless']);
const DEFAULT_LIFETIME_S = 3600;
const EXCHANGE_TIMEOUT_MS = 30_000;
const MAX_ANSWER_BYTES = 64 * 1024;

export const RENEW_WINDOW_MS = 10 * 60_000;
export const KEEP_INTERVAL_MS = 60_000;

const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  id_token: z.string().optional(),
  scope: z.string().optional(),
});
const tokenSharingMetadataSchema = z.object({ clientID: z.string().min(1), scopes: z.array(z.string()).optional() });
const claimsSchema = z.object({
  chatgpt_account_id: z.string().optional(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().optional() }).optional(),
  organizations: z.array(z.object({ id: z.string() })).optional(),
});

const accountIdOf = (token: string | undefined) => {
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

export function exchangeRequestOf(login: ExchangeLogin) {
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

export function exchangedLoginOf(login: ExchangeLogin, answer: z.infer<typeof tokenAnswerSchema>, now: number) {
  const value = { access: answer.access_token, refresh: answer.refresh_token, expires: now + (answer.expires_in ?? DEFAULT_LIFETIME_S) * 1000 };
  if (login.methodID === TOKEN_SHARING_METHOD) {
    const metadata = tokenSharingMetadataSchema.parse(login.metadata);
    const scopes = answer.scope?.split(' ').filter(Boolean) ?? metadata.scopes ?? [];
    return { ...value, metadata: { clientID: metadata.clientID, scopes } };
  }
  const accountID = accountIdOf(answer.id_token) ?? accountIdOf(answer.access_token);
  return { ...value, metadata: accountID ? { accountID } : login.metadata };
}

export function createLoginExchange({ fetch = globalThis.fetch, now = Date.now, userAgent = 'OpenChamber' }: LoginExchangeOptions = {}): Exchange {
  return async (login: ExchangeLogin) => {
    const request = exchangeRequestOf(login);
    if (!request) throw new Error(`The ${login.methodID} login cannot be renewed by OpenChamber`);
    const response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent, accept: 'application/json' },
      body: new URLSearchParams(request.body).toString(),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const error: Error & { code?: string } = new Error(`The login issuer answered ${response.status}`);
      if (response.status >= 400 && response.status < 500) error.code = 'login_refused';
      throw error;
    }
    const text = await response.text();
    if (text.length > MAX_ANSWER_BYTES) throw new Error('The login issuer answered with too large a body');
    let parsed;
    try {
      parsed = tokenAnswerSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = { success: false } satisfies { success: false };
    }
    if (!parsed.success) throw new Error('The login issuer did not answer with tokens');
    return exchangedLoginOf(login, parsed.data, now());
  };
}

export function createLoginKeeper({ readLogin, renewLogin, exchange, holders, say, now = Date.now, logger = console }: LoginKeeperOptions) {
  const renewing = new Map<string, Promise<StoredLogin | null>>();
  const refused = new Map<string, number>();
  const said = new Map<string, Map<string, string>>();
  const fingerprintOf = (login: StoredLogin) => crypto.createHash('sha256').update(login.access).digest('hex');

  const renew = (provider: string) => {
    if (!renewing.has(provider)) {
      renewing.set(provider, renewLogin(provider, exchange).finally(() => { renewing.delete(provider); }));
    }
    return transferValue(renewing.get(provider));
  };

  const fresh = async (provider: string) => {
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
      if (failureProperty(error, 'code') === 'login_refused') refused.set(provider, login.expires);
      logger.warn?.(`[spaces] the ${provider} login on this computer could not be renewed: ${errorSummary(error)}`);
      return login;
    }
  };

  const tick = async () => {
    let holding;
    try {
      holding = await holders();
    } catch (error) {
      logger.warn?.(`[spaces] could not tell which spaces hold a login: ${errorSummary(error)}`);
      return;
    }
    const logins = new Map<string, StoredLogin | null>();
    for (const { spaceId, grant } of holding) {
      if (!logins.has(grant.provider)) {
        logins.set(grant.provider, await fresh(grant.provider).catch((error) => {
          logger.warn?.(`[spaces] the ${grant.provider} login on this computer could not be read: ${errorSummary(error)}`);
          return null;
        }));
      }
      const login = logins.get(grant.provider);
      if (!login || login.methodID !== grant.method || loginEnded(grant.provider, login, now())) continue;
      const fingerprint = fingerprintOf(login);
      if (said.get(spaceId)?.get(grant.id) === fingerprint) continue;
      if ((await say(spaceId, grant, login)) === null) continue;
      if (!said.has(spaceId)) said.set(spaceId, new Map());
      transferValue(said.get(spaceId), 'set').set(grant.id, fingerprint);
    }
    const stillHolding = new Set(holding.map(({ spaceId }) => spaceId));
    for (const spaceId of said.keys()) if (!stillHolding.has(spaceId)) said.delete(spaceId);
  };

  return { fresh, tick };
}
