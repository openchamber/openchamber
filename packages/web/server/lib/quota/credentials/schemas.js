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
 * Schemas are consumed by `registry.js`:
 *  - `validateCredential()` delegates to `schema.validate()`
 *  - `discoverCredentials()` iterates `schema.legacyFiles`
 *
 * @module quota/credentials/schemas
 */

import { redactCookie, redactToken } from '../utils/redact.js';

/**
 * Check that a value is a non-empty string.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Check that a cookie string contains a given cookie name segment
 * (e.g. 'access-token=' or 'csrftoken=').
 *
 * @param {string} cookie
 * @param {string} name - e.g. 'access-token='
 * @returns {boolean}
 */
function cookieContains(cookie, name) {
  return typeof cookie === 'string' && cookie.includes(name);
}

function hasMistralCsrfCookie(cookie) {
  return typeof cookie === 'string' && /(?:^|;\s*)(?:csrftoken|csrf_token_[^=;]+)=/.test(cookie);
}

function invalidCookieHeaderValue(cookie) {
  if (typeof cookie !== 'string') return false;
  return [...cookie].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f || code > 0xff;
  });
}

function validateCookieHeaderValue(cookie, label = 'Cookie') {
  if (invalidCookieHeaderValue(cookie)) {
    return invalid(`${label} contains invalid characters; paste literal cookie values without ellipses or placeholders`);
  }
  return { valid: true };
}

/**
 * Validate that `credential[field]` is a non-empty string.
 *
 * @param {object} credential
 * @param {string} field
 * @returns {{ valid: boolean, error?: string }}
 */
function requireField(credential, field) {
  if (!isNonEmptyString(credential[field])) {
    return { valid: false, error: `Missing required field: ${field}` };
  }
  return { valid: true };
}

/**
 * Build a failure result with a message.
 *
 * @param {string} message
 * @returns {{ valid: false, error: string }}
 */
function invalid(message) {
  return { valid: false, error: message };
}

/**
 * Strip one layer of matched surrounding quotes and surrounding whitespace.
 *
 * @param {*} value
 * @returns {*}
 */
function stripWrappingQuotes(value) {
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
 *
 * @param {*} value
 * @returns {*}
 */
function normalizeAuthCookieValue(value) {
  if (typeof value !== 'string') return value;
  let v = value.trim().replace(/^auth\s*[:=]\s*/i, '');
  return stripWrappingQuotes(v);
}

// ---------------------------------------------------------------------------
// Provider schemas
// ---------------------------------------------------------------------------

/**
 * AtlasCloud — cookie-based auth.
 *
 * Cookie must contain `access-token=`. `accountUuid` is optional.
 * Legacy file: `atlas-cookies.json`.
 */
const atlascloud = {
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
    const out = { cookie: redactCookie(credential.cookie) };
    if (credential.accountUuid !== undefined) {
      out.accountUuid = credential.accountUuid;
    }
    return out;
  },
  legacyFiles: ['atlas-cookies.json'],
  multiAccount: false,
};

/**
 * BytePlus — cookie-based auth.
 *
 * Cookie must contain `csrfToken=`. Legacy file: `byteplus-cookies.json`.
 */
const byteplus = {
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
    return { cookie: redactCookie(credential.cookie) };
  },
  legacyFiles: ['byteplus-cookies.json'],
  multiAccount: false,
};

/**
 * LongCat — passport token OR cookie auth.
 *
 * Accepts either `passportToken` (string) or `cookie` (string containing
 * `passport_token_key=`). `region` is optional.
 * Legacy file: `longcat-cookies.json`.
 */
const longcat = {
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
    const out = {};
    if (credential.passportToken !== undefined) {
      out.passportToken = redactToken(credential.passportToken);
    }
    if (credential.cookie !== undefined) {
      out.cookie = redactCookie(credential.cookie);
    }
    if (credential.region !== undefined) {
      out.region = credential.region;
    }
    return out;
  },
  legacyFiles: ['longcat-cookies.json'],
  multiAccount: false,
};

/**
 * QwenCloud — ticket-based auth.
 *
 * `ticket` and `isg` are required. `aliyunPk` (login_aliyunid_pk) is optional:
 * the international Token Plan (home.qwencloud.com) authenticates without it,
 * confirmed by live traffic — only mainland Aliyun-passport sessions set it.
 * `esmTicket` is optional. Legacy file: `qwencloud-cookies.json`.
 */
const qwencloud = {
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
    const out = { ticket: redactToken(credential.ticket) };
    if (credential.aliyunPk !== undefined) {
      out.aliyunPk = credential.aliyunPk;
    }
    if (credential.isg !== undefined) {
      out.isg = '[REDACTED]';
    }
    if (credential.esmTicket !== undefined) {
      out.esmTicket = redactToken(credential.esmTicket);
    }
    return out;
  },
  legacyFiles: ['qwencloud-cookies.json'],
  multiAccount: false,
};

/**
 * StepFun — oasis token auth.
 *
 * `oasisToken` and `oasisWebid` are both required (the canonical
 * stepfun-cookies.json loader requires `oasisToken && oasisWebid`).
 * `sessionToken` is optional. Legacy file: `stepfun-cookies.json`.
 */
const stepfun = {
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
    const out = { oasisToken: redactToken(credential.oasisToken) };
    if (credential.oasisWebid !== undefined) {
      out.oasisWebid = credential.oasisWebid;
    }
    if (credential.sessionToken !== undefined) {
      out.sessionToken = redactToken(credential.sessionToken);
    }
    return out;
  },
  legacyFiles: ['stepfun-cookies.json'],
  multiAccount: false,
};

/**
 * Mistral — cookie-based auth, multi-account.
 *
 * Cookie must contain `csrftoken=`. Supports an `accounts` array where
 * each account has its own `cookie`. Legacy file: `mistral-cookies.json`.
 */
const mistral = {
  requiredFields: ['cookie'],
  optionalFields: [],
  validate(credential) {
    if (Array.isArray(credential.accounts) && credential.accounts.length > 0) {
      for (const account of credential.accounts) {
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
        accounts: credential.accounts.map((account) => ({
          ...account,
          cookie: redactCookie(account.cookie),
        })),
      };
    }
    return { cookie: redactCookie(credential.cookie) };
  },
  legacyFiles: ['mistral-cookies.json'],
  multiAccount: true,
};

/**
 * Ollama Cloud — cookie-based auth.
 *
 * Cookie must contain `__Secure-session=`.
 * Legacy file: `ollama-cookies.json`.
 */
const ollamaCloud = {
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
    return { cookie: redactCookie(credential.cookie) };
  },
  legacyFiles: ['ollama-cookies.json'],
  multiAccount: false,
};

/**
 * OpenCode Go — workspace ID + auth cookie, or multi-account.
 *
 * Single account requires BOTH `workspaceId` and `authCookie` (the canonical
 * opencode-go.json loader requires `workspaceId && authCookie`). Multi-account
 * uses an `accounts` array where each account has both fields.
 * Legacy file: `opencode-go.json`.
 */
const opencodeGo = {
  requiredFields: ['workspaceId', 'authCookie'],
  optionalFields: [],
  normalize(credential) {
    const cleanOne = (entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const out = { ...entry };
      if (typeof out.authCookie === 'string') out.authCookie = normalizeAuthCookieValue(out.authCookie);
      if (typeof out.workspaceId === 'string') out.workspaceId = stripWrappingQuotes(out.workspaceId);
      return out;
    };
    if (Array.isArray(credential.accounts)) {
      return { ...credential, accounts: credential.accounts.map(cleanOne) };
    }
    return cleanOne(credential);
  },
  validate(credential) {
    if (Array.isArray(credential.accounts) && credential.accounts.length > 0) {
      for (const account of credential.accounts) {
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
        accounts: credential.accounts.map((account) => {
          const out = { ...account };
          if (account.authCookie !== undefined) {
            out.authCookie = redactToken(account.authCookie);
          }
          return out;
        }),
      };
    }
    const out = { workspaceId: credential.workspaceId };
    if (credential.authCookie !== undefined) {
      out.authCookie = redactToken(credential.authCookie);
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
 *
 * @type {Record<string, object>}
 */
export const PROVIDER_CREDENTIAL_SCHEMAS = {
  atlascloud,
  byteplus,
  longcat,
  qwencloud,
  stepfun,
  mistral,
  'ollama-cloud': ollamaCloud,
  'opencode-go': opencodeGo,
};
