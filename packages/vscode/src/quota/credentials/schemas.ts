/**
 * Provider credential schemas
 *
 * Executable validation rules for every manual-auth provider's credential
 * shape. Each schema declares required/optional fields, a `validate()`
 * function returning `{ valid, error? }`, a `redact()` function returning
 * a sanitized copy, the list of legacy cookie/config files to discover
 * for import, and a `multiAccount` flag when the provider supports an
 * `accounts` array.
 *
 * Schemas are consumed by `registry.ts`:
 *  - `validateCredential()` delegates to `schema.validate()`
 *  - `discoverCredentials()` iterates `schema.legacyFiles`
 *
 * @module quota/credentials/schemas
 */

import { redactCookie, redactToken } from './redact';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface ProviderCredentialSchema {
  requiredFields: string[];
  optionalFields: string[];
  validate: (credential: Record<string, unknown>) => ValidationResult;
  redact: (credential: Record<string, unknown>) => Record<string, unknown>;
  legacyFiles: string[];
  multiAccount: boolean;
  normalize?: (credential: Record<string, unknown>) => Record<string, unknown>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cookieContains(cookie: unknown, name: string): boolean {
  return typeof cookie === 'string' && cookie.includes(name);
}

function hasMistralCsrfCookie(cookie: unknown): boolean {
  return typeof cookie === 'string' && /(?:^|;\s*)(?:csrftoken|csrf_token_[^=;]+)=/.test(cookie);
}

function invalidCookieHeaderValue(cookie: unknown): boolean {
  if (typeof cookie !== 'string') return false;
  return [...cookie].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || code > 0xff;
  });
}

function validateCookieHeaderValue(cookie: unknown, label = 'Cookie'): ValidationResult {
  if (invalidCookieHeaderValue(cookie)) {
    return invalid(`${label} contains invalid characters; paste literal cookie values without ellipses or placeholders`);
  }
  return { valid: true };
}

function requireField(credential: Record<string, unknown>, field: string): ValidationResult {
  if (!isNonEmptyString(credential[field])) {
    return { valid: false, error: `Missing required field: ${field}` };
  }
  return { valid: true };
}

function invalid(message: string): ValidationResult {
  return { valid: false, error: message };
}

/**
 * Strip one layer of matched surrounding quotes and surrounding whitespace.
 */
function stripWrappingQuotes(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Normalize a single-value auth cookie pasted from browser devtools, where it
 * appears as `auth:"<value>"` or `auth=<value>`. The stored field is the bare
 * value (later sent as `auth=<value>`), so the leading name and quotes are noise.
 */
function normalizeAuthCookieValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim().replace(/^auth\s*[:=]\s*/i, '');
  return stripWrappingQuotes(v);
}

// ---------------------------------------------------------------------------
// Provider schemas
// ---------------------------------------------------------------------------

const atlascloud: ProviderCredentialSchema = {
  requiredFields: ['cookie'],
  optionalFields: ['accountUuid'],
  validate(credential) {
    const fieldCheck = requireField(credential, 'cookie');
    if (!fieldCheck.valid) return fieldCheck;
    if (!cookieContains(credential.cookie, 'access-token=')) {
      return invalid('Cookie must contain access-token=');
    }
    return { valid: true };
  },
  redact(credential) {
    const out: Record<string, unknown> = { cookie: redactCookie(credential.cookie as string) };
    if (credential.accountUuid !== undefined) {
      out.accountUuid = credential.accountUuid;
    }
    return out;
  },
  legacyFiles: ['atlas-cookies.json'],
  multiAccount: false,
};

const byteplus: ProviderCredentialSchema = {
  requiredFields: ['cookie'],
  optionalFields: [],
  validate(credential) {
    const fieldCheck = requireField(credential, 'cookie');
    if (!fieldCheck.valid) return fieldCheck;
    if (!cookieContains(credential.cookie, 'csrfToken=')) {
      return invalid('Cookie must contain csrfToken=');
    }
    return { valid: true };
  },
  redact(credential) {
    return { cookie: redactCookie(credential.cookie as string) };
  },
  legacyFiles: ['byteplus-cookies.json'],
  multiAccount: false,
};

const longcat: ProviderCredentialSchema = {
  requiredFields: ['passportToken', 'cookie'],
  optionalFields: ['region'],
  validate(credential) {
    const hasPassport = isNonEmptyString(credential.passportToken);
    const hasCookie = isNonEmptyString(credential.cookie);
    if (!hasPassport && !hasCookie) {
      return invalid('Missing required field: passportToken or cookie');
    }
    if (hasCookie && !cookieContains(credential.cookie, 'passport_token_key=')) {
      return invalid('Cookie must contain passport_token_key=');
    }
    return { valid: true };
  },
  redact(credential) {
    const out: Record<string, unknown> = {};
    if (credential.passportToken !== undefined) {
      out.passportToken = redactToken(credential.passportToken as string);
    }
    if (credential.cookie !== undefined) {
      out.cookie = redactCookie(credential.cookie as string);
    }
    if (credential.region !== undefined) {
      out.region = credential.region;
    }
    return out;
  },
  legacyFiles: ['longcat-cookies.json'],
  multiAccount: false,
};

const qwencloud: ProviderCredentialSchema = {
  requiredFields: ['ticket', 'isg'],
  optionalFields: ['aliyunPk', 'esmTicket'],
  validate(credential) {
    for (const field of ['ticket', 'isg']) {
      const fieldCheck = requireField(credential, field);
      if (!fieldCheck.valid) return fieldCheck;
    }
    return { valid: true };
  },
  redact(credential) {
    const out: Record<string, unknown> = { ticket: redactToken(credential.ticket as string) };
    if (credential.aliyunPk !== undefined) {
      out.aliyunPk = credential.aliyunPk;
    }
    if (credential.isg !== undefined) {
      out.isg = '[REDACTED]';
    }
    if (credential.esmTicket !== undefined) {
      out.esmTicket = redactToken(credential.esmTicket as string);
    }
    return out;
  },
  legacyFiles: ['qwencloud-cookies.json'],
  multiAccount: false,
};

const stepfun: ProviderCredentialSchema = {
  requiredFields: ['oasisToken', 'oasisWebid'],
  optionalFields: ['sessionToken'],
  validate(credential) {
    for (const field of ['oasisToken', 'oasisWebid']) {
      const fieldCheck = requireField(credential, field);
      if (!fieldCheck.valid) return fieldCheck;
    }
    return { valid: true };
  },
  redact(credential) {
    const out: Record<string, unknown> = { oasisToken: redactToken(credential.oasisToken as string) };
    if (credential.oasisWebid !== undefined) {
      out.oasisWebid = credential.oasisWebid;
    }
    if (credential.sessionToken !== undefined) {
      out.sessionToken = redactToken(credential.sessionToken as string);
    }
    return out;
  },
  legacyFiles: ['stepfun-cookies.json'],
  multiAccount: false,
};

const mistral: ProviderCredentialSchema = {
  requiredFields: ['cookie'],
  optionalFields: [],
  validate(credential) {
    if (Array.isArray(credential.accounts) && credential.accounts.length > 0) {
      for (const account of credential.accounts as Array<Record<string, unknown>>) {
        if (!account || typeof account !== 'object') {
          return invalid('Each account must be an object');
        }
        const fieldCheck = requireField(account, 'cookie');
        if (!fieldCheck.valid) return fieldCheck;
        const headerCheck = validateCookieHeaderValue(account.cookie, 'Account cookie');
        if (!headerCheck.valid) return headerCheck;
        if (!hasMistralCsrfCookie(account.cookie)) {
          return invalid('Account cookie must contain csrftoken= or csrf_token_<id>=');
        }
      }
      return { valid: true };
    }
    const fieldCheck = requireField(credential, 'cookie');
    if (!fieldCheck.valid) return fieldCheck;
    const headerCheck = validateCookieHeaderValue(credential.cookie);
    if (!headerCheck.valid) return headerCheck;
    if (!hasMistralCsrfCookie(credential.cookie)) {
      return invalid('Cookie must contain csrftoken= or csrf_token_<id>=');
    }
    return { valid: true };
  },
  redact(credential) {
    if (Array.isArray(credential.accounts)) {
      return {
        accounts: (credential.accounts as Array<Record<string, unknown>>).map((account) => ({
          ...account,
          cookie: redactCookie(account.cookie as string),
        })),
      };
    }
    return { cookie: redactCookie(credential.cookie as string) };
  },
  legacyFiles: ['mistral-cookies.json'],
  multiAccount: true,
};

const ollamaCloud: ProviderCredentialSchema = {
  requiredFields: ['cookie'],
  optionalFields: [],
  validate(credential) {
    const fieldCheck = requireField(credential, 'cookie');
    if (!fieldCheck.valid) return fieldCheck;
    if (!cookieContains(credential.cookie, '__Secure-session=')) {
      return invalid('Cookie must contain __Secure-session=');
    }
    return { valid: true };
  },
  redact(credential) {
    return { cookie: redactCookie(credential.cookie as string) };
  },
  legacyFiles: ['ollama-cookies.json'],
  multiAccount: false,
};

const opencodeGo: ProviderCredentialSchema = {
  requiredFields: ['workspaceId', 'authCookie'],
  optionalFields: [],
  normalize(credential) {
    const cleanOne = (entry: Record<string, unknown>): Record<string, unknown> => {
      if (!entry || typeof entry !== 'object') return entry;
      const out: Record<string, unknown> = { ...entry };
      if (typeof out.authCookie === 'string') out.authCookie = normalizeAuthCookieValue(out.authCookie);
      if (typeof out.workspaceId === 'string') out.workspaceId = stripWrappingQuotes(out.workspaceId);
      return out;
    };
    if (Array.isArray(credential.accounts)) {
      return { ...credential, accounts: (credential.accounts as Array<Record<string, unknown>>).map(cleanOne) };
    }
    return cleanOne(credential);
  },
  validate(credential) {
    if (Array.isArray(credential.accounts) && credential.accounts.length > 0) {
      for (const account of credential.accounts as Array<Record<string, unknown>>) {
        if (!account || typeof account !== 'object') {
          return invalid('Each account must be an object');
        }
        for (const field of ['workspaceId', 'authCookie']) {
          const fieldCheck = requireField(account, field);
          if (!fieldCheck.valid) return fieldCheck;
        }
      }
      return { valid: true };
    }
    for (const field of ['workspaceId', 'authCookie']) {
      const fieldCheck = requireField(credential, field);
      if (!fieldCheck.valid) return fieldCheck;
    }
    return { valid: true };
  },
  redact(credential) {
    if (Array.isArray(credential.accounts)) {
      return {
        accounts: (credential.accounts as Array<Record<string, unknown>>).map((account) => {
          const out: Record<string, unknown> = { ...account };
          if (account.authCookie !== undefined) {
            out.authCookie = redactToken(account.authCookie as string);
          }
          return out;
        }),
      };
    }
    const out: Record<string, unknown> = { workspaceId: credential.workspaceId };
    if (credential.authCookie !== undefined) {
      out.authCookie = redactToken(credential.authCookie as string);
    }
    return out;
  },
  legacyFiles: ['opencode-go.json'],
  multiAccount: true,
};

/**
 * Manual-credential providers only. Providers OpenCode can authenticate via
 * auth.json (openai, anthropic, google, zai, xai, minimax, poe) must never be
 * added here — they read their key from OpenCode config, not user-supplied
 * credentials.
 */
export const PROVIDER_CREDENTIAL_SCHEMAS: Record<string, ProviderCredentialSchema> = {
  atlascloud,
  byteplus,
  longcat,
  qwencloud,
  stepfun,
  mistral,
  'ollama-cloud': ollamaCloud,
  'opencode-go': opencodeGo,
};