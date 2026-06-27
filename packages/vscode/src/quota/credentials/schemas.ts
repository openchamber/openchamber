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

import { redactCookie, redactToken, redactApiKey } from './redact';

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
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cookieContains(cookie: unknown, name: string): boolean {
  return typeof cookie === 'string' && cookie.includes(name);
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
    if (!cookieContains(credential.cookie, 'csrfToken')) {
      return invalid('Cookie must contain csrfToken');
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
  requiredFields: ['ticket'],
  optionalFields: ['aliyunPk', 'isg', 'esmTicket'],
  validate(credential) {
    return requireField(credential, 'ticket');
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
  requiredFields: ['oasisToken'],
  optionalFields: ['oasisWebid', 'sessionToken'],
  validate(credential) {
    return requireField(credential, 'oasisToken');
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
        if (!cookieContains(account.cookie, 'csrftoken=')) {
          return invalid('Account cookie must contain csrftoken=');
        }
      }
      return { valid: true };
    }
    const fieldCheck = requireField(credential, 'cookie');
    if (!fieldCheck.valid) return fieldCheck;
    if (!cookieContains(credential.cookie, 'csrftoken=')) {
      return invalid('Cookie must contain csrftoken=');
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
  requiredFields: ['workspaceId', 'accounts'],
  optionalFields: ['authCookie'],
  validate(credential) {
    if (Array.isArray(credential.accounts) && credential.accounts.length > 0) {
      for (const account of credential.accounts as Array<Record<string, unknown>>) {
        if (!account || typeof account !== 'object') {
          return invalid('Each account must be an object');
        }
        const fieldCheck = requireField(account, 'workspaceId');
        if (!fieldCheck.valid) return fieldCheck;
      }
      return { valid: true };
    }
    return requireField(credential, 'workspaceId');
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

const poe: ProviderCredentialSchema = {
  requiredFields: ['apiKey'],
  optionalFields: [],
  validate(credential) {
    return requireField(credential, 'apiKey');
  },
  redact(credential) {
    return { apiKey: redactApiKey(credential.apiKey as string) };
  },
  legacyFiles: [],
  multiAccount: false,
};

const xai: ProviderCredentialSchema = {
  requiredFields: ['cookie'],
  optionalFields: [],
  validate(credential) {
    const fieldCheck = requireField(credential, 'cookie');
    if (!fieldCheck.valid) return fieldCheck;
    if (
      !cookieContains(credential.cookie, 'sso') &&
      !cookieContains(credential.cookie, '__Secure-next-auth')
    ) {
      return invalid('Cookie must contain sso or __Secure-next-auth');
    }
    return { valid: true };
  },
  redact(credential) {
    return { cookie: redactCookie(credential.cookie as string) };
  },
  legacyFiles: [],
  multiAccount: false,
};

export const PROVIDER_CREDENTIAL_SCHEMAS: Record<string, ProviderCredentialSchema> = {
  atlascloud,
  byteplus,
  longcat,
  qwencloud,
  stepfun,
  mistral,
  'ollama-cloud': ollamaCloud,
  'opencode-go': opencodeGo,
  poe,
  xai,
};