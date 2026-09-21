/**
 * Provider OAuth flow helpers.
 *
 * `POST /provider/{id}/oauth/authorize` answers with the completion method that
 * decides what the client has to do next:
 *
 * - `auto` — the client must call `oauth/callback` right away and hold that
 *   request open. Upstream blocks inside it (device-code polling, or waiting on
 *   a loopback redirect) until the user finishes signing in, and only then
 *   persists the credential. Nothing is stored if the client never calls it.
 * - `code` — the user copies a code out of the browser and hands it to
 *   `oauth/callback`.
 *
 * Every auth plugin shipped with OpenCode uses `auto`; `code` stays supported
 * for third-party auth plugins that still return it.
 */

import type { I18nKey, I18nParams } from '@/lib/i18n';

export type OAuthCompletionMethod = 'auto' | 'code';

export type ProviderOAuthTranslator = (key: I18nKey, params?: I18nParams) => string;

export interface OAuthAuthorization {
  method: OAuthCompletionMethod;
  url?: string;
  instructions?: string;
  /** Device code surfaced separately so it can be copied on its own. */
  userCode?: string;
}

export const shouldOpenAuthorizationUrl = (providerId: string, url?: string): boolean =>
  Boolean(url) && providerId !== 'claude-code';

export interface AuthPromptOption {
  label: string;
  value: string;
  hint?: string;
}

export interface AuthPromptCondition {
  key: string;
  op: 'eq' | 'neq';
  value: string;
}

export interface AuthPrompt {
  type: 'text' | 'select';
  key: string;
  message: string;
  placeholder?: string;
  options: AuthPromptOption[];
  when?: AuthPromptCondition;
}

/**
 * Device codes are only carried inside the human-readable instructions
 * (`Enter code: ABCD-1234`), so they are recovered by shape.
 */
const DEVICE_CODE_PATTERN = /[A-Z0-9]{4}-[A-Z0-9]{4,5}/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const parsePromptOptions = (value: unknown): AuthPromptOption[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AuthPromptOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const optionValue = asText(entry.value);
    if (optionValue === undefined) {
      continue;
    }
    options.push({
      value: optionValue,
      label: asText(entry.label) ?? optionValue,
      ...(asText(entry.hint) ? { hint: asText(entry.hint)! } : {}),
    });
  }
  return options;
};

const parsePromptCondition = (value: unknown): AuthPromptCondition | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const key = asText(value.key);
  const op = value.op === 'eq' || value.op === 'neq' ? value.op : undefined;
  if (!key || !op || typeof value.value !== 'string') {
    return undefined;
  }
  return { key, op, value: value.value };
};

/** Parses the `prompts` an auth method wants answered before `authorize`. */
export const parseAuthPrompts = (value: unknown): AuthPrompt[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const prompts: AuthPrompt[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const key = asText(entry.key);
    if (!key) {
      continue;
    }
    const type = entry.type === 'select' ? 'select' : 'text';
    const options = type === 'select' ? parsePromptOptions(entry.options) : [];
    // A select with no usable option can never be answered; skipping it would
    // silently drop a required input, so treat the whole method as unusable.
    if (type === 'select' && options.length === 0) {
      continue;
    }
    const when = parsePromptCondition(entry.when);
    prompts.push({
      type,
      key,
      message: asText(entry.message) ?? key,
      options,
      ...(asText(entry.placeholder) ? { placeholder: asText(entry.placeholder)! } : {}),
      ...(when ? { when } : {}),
    });
  }
  return prompts;
};

/** True when a prompt's `when` condition is satisfied by the answers so far. */
export const isPromptVisible = (prompt: AuthPrompt, values: Record<string, string>): boolean => {
  if (!prompt.when) {
    return true;
  }
  const current = values[prompt.when.key] ?? '';
  return prompt.when.op === 'eq'
    ? current === prompt.when.value
    : current !== prompt.when.value;
};

export const visiblePrompts = (
  prompts: AuthPrompt[],
  values: Record<string, string>,
): AuthPrompt[] => prompts.filter((prompt) => isPromptVisible(prompt, values));

/** Selects preselect their first option so the form always starts answerable. */
export const defaultPromptValues = (prompts: AuthPrompt[]): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const prompt of prompts) {
    values[prompt.key] = prompt.type === 'select' ? (prompt.options[0]?.value ?? '') : '';
  }
  return values;
};

/** First visible prompt still left blank, or `null` when the form is complete. */
export const firstUnansweredPrompt = (
  prompts: AuthPrompt[],
  values: Record<string, string>,
): AuthPrompt | null =>
  visiblePrompts(prompts, values).find((prompt) => (values[prompt.key] ?? '').trim().length === 0) ?? null;

/**
 * Builds the `inputs` payload for `authorize`. Hidden prompts are dropped so a
 * stale answer from a since-changed branch is never sent upstream.
 */
export const collectPromptInputs = (
  prompts: AuthPrompt[],
  values: Record<string, string>,
): Record<string, string> => {
  const inputs: Record<string, string> = {};
  for (const prompt of visiblePrompts(prompts, values)) {
    inputs[prompt.key] = (values[prompt.key] ?? '').trim();
  }
  return inputs;
};

/**
 * Normalizes an `authorize` response.
 *
 * Anything that is not explicitly `code` is treated as `auto`: `auto` only
 * means "call back and wait", which is also the safe reading of an unknown
 * method, whereas guessing `code` would strand the user at a paste field no
 * provider can fill.
 *
 * Returns `null` when the response carries nothing the user can act on.
 */
export const parseAuthorization = (payload: unknown): OAuthAuthorization | null => {
  const outer: Record<string, unknown> = isRecord(payload) ? payload : {};
  const record: Record<string, unknown> = isRecord(outer.data) ? outer.data : outer;

  const url =
    asText(record.url)
    ?? asText(record.verification_uri_complete)
    ?? asText(record.verification_uri);
  const instructions = asText(record.instructions) ?? asText(record.message);

  if (!url && !instructions) {
    return null;
  }

  const userCode =
    asText(record.user_code)
    ?? asText(record.userCode)
    ?? (instructions ? DEVICE_CODE_PATTERN.exec(instructions)?.[0] : undefined);

  return {
    method: record.method === 'code' ? 'code' : 'auto',
    ...(url ? { url } : {}),
    ...(instructions ? { instructions } : {}),
    ...(userCode ? { userCode } : {}),
  };
};

/**
 * Renders a `ProviderAuthApiError` as user-facing copy.
 *
 * Validation failures carry a message authored by the auth plugin (a field
 * rule such as "URL or domain is required"); it is shown verbatim because only
 * the plugin knows which input was rejected.
 */
export const describeOAuthError = (
  error: unknown,
  t: ProviderOAuthTranslator,
  fallbackKey: I18nKey,
): string => {
  const record: Record<string, unknown> = isRecord(error) ? error : {};
  const data: Record<string, unknown> = isRecord(record.data) ? record.data : {};

  switch (record.name) {
    case 'ProviderAuthOauthMissing':
      return t('settings.providers.page.auth.oauth.error.sessionExpired');
    case 'ProviderAuthOauthCodeMissing':
      return t('settings.providers.page.auth.oauth.error.codeRequired');
    case 'ProviderAuthOauthCallbackFailed':
      return t('settings.providers.page.auth.oauth.error.declined');
    case 'ProviderAuthValidationFailed':
      return asText(data.message) ?? t('settings.providers.page.auth.oauth.error.invalidInput');
    default:
      return t(fallbackKey);
  }
};
