/**
 * Provider OAuth flow helpers.
 *
 * OpenCode v2 signs a provider in through its *integration*:
 * `integration.oauth.connect` opens an attempt and answers with the mode that
 * decides what the client has to do next:
 *
 * - `auto` — the user finishes in the browser and the client polls
 *   `integration.oauth.status` until the attempt completes. The credential is
 *   only stored once the attempt reports `complete`.
 * - `code` — the user copies a code out of the browser and hands it to
 *   `integration.oauth.complete`.
 *
 * An attempt the user walks away from is dropped with
 * `integration.oauth.cancel`, and every attempt carries its own expiry.
 */

import type { FormField, FormValue, FormWhen } from '@opencode/client';
import type { I18nKey, I18nParams } from '@/lib/i18n';

export type OAuthCompletionMode = 'auto' | 'code';

export type ProviderOAuthTranslator = (key: I18nKey, params?: I18nParams) => string;

export interface OAuthAttempt {
  attemptID: string;
  mode: OAuthCompletionMode;
  url: string;
  instructions: string;
}

export const shouldOpenAuthorizationUrl = (providerId: string, url?: string): boolean =>
  Boolean(url) && providerId !== 'claude-code';

/**
 * Device codes are only carried inside the human-readable instructions
 * (`Enter code: ABCD-1234`), so they are recovered by shape.
 */
const DEVICE_CODE_PATTERN = /[A-Z0-9]{4}-[A-Z0-9]{4,5}/;

/** The device/user code to surface on its own, when the instructions carry one. */
export const extractUserCode = (instructions: string): string | undefined =>
  DEVICE_CODE_PATTERN.exec(instructions)?.[0] ?? undefined;

/**
 * Fields the editor can render and answer. `external` fields only point the
 * user at a URL, so they never take part in the answer payload.
 */
export type AnswerableField = Exclude<FormField, { type: 'external' }>;

export const isAnswerableField = (field: FormField): field is AnswerableField =>
  field.type !== 'external';

/** The label a field shows; falls back to its key so nothing renders blank. */
export const fieldLabel = (field: FormField): string => field.title ?? field.key;

// Mirrors OpenCode's `matches()`: a condition on a field that has no active
// answer is false for `eq` and `neq` alike.
const matchesCondition = (condition: FormWhen, value: FormValue | undefined): boolean => {
  if (value === undefined) return false;
  const current = String(value);
  const expected = String(condition.value);
  return condition.op === 'eq' ? current === expected : current !== expected;
};

/**
 * True when every `when` condition on a field is satisfied by the answers of
 * the fields that are themselves active; pass the answers `visibleFields`
 * accumulated, not the raw value map.
 */
export const isFieldVisible = (field: FormField, activeValues: Record<string, FormValue>): boolean => {
  // `external` fields are pure links and carry no conditions.
  if (!isAnswerableField(field)) return true;
  return (field.when ?? []).every((condition) => matchesCondition(condition, activeValues[condition.key]));
};

/**
 * Fields in declaration order whose conditions hold against the answers of
 * the active fields before them, so a hidden field's value cannot reveal a
 * later one. Same walk as the server's form evaluation.
 */
export const visibleFields = (
  fields: readonly FormField[],
  values: Record<string, FormValue>,
): FormField[] => {
  const active: Record<string, FormValue> = {};
  const shown: FormField[] = [];
  for (const field of fields) {
    if (!isFieldVisible(field, active)) continue;
    shown.push(field);
    const value = values[field.key];
    if (isAnswerableField(field) && value !== undefined) active[field.key] = value;
  }
  return shown;
};

/**
 * Seeds the answer map. A field's declared default wins; otherwise a field with
 * options preselects its first one so the form always starts answerable.
 */
export const defaultFieldValues = (fields: readonly FormField[]): Record<string, FormValue> => {
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    switch (field.type) {
      case 'external':
        break;
      case 'boolean':
        values[field.key] = field.default ?? false;
        break;
      case 'number':
      case 'integer':
        if (typeof field.default === 'number') values[field.key] = field.default;
        break;
      case 'multiselect':
        values[field.key] = field.default ?? [];
        break;
      case 'string':
        values[field.key] = field.default ?? field.options?.[0]?.value ?? '';
        break;
    }
  }
  return values;
};

const isBlank = (value: FormValue | undefined): boolean => {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

/** First visible required field still left blank, or `null` when the form is complete. */
export const firstUnansweredField = (
  fields: readonly FormField[],
  values: Record<string, FormValue>,
): FormField | null =>
  visibleFields(fields, values).find(
    (field) => isAnswerableField(field) && field.required === true && isBlank(values[field.key]),
  ) ?? null;

/**
 * Builds the `answer` payload for `connect`. Hidden fields are dropped so a
 * stale answer from a since-changed branch is never sent upstream, and so are
 * blank optional fields, which upstream reads as "not provided".
 */
export const collectFieldAnswer = (
  fields: readonly FormField[],
  values: Record<string, FormValue>,
): Record<string, FormValue> => {
  const answer: Record<string, FormValue> = {};
  for (const field of visibleFields(fields, values)) {
    if (!isAnswerableField(field)) continue;
    const value = values[field.key];
    if (isBlank(value) || value === undefined) continue;
    answer[field.key] = typeof value === 'string' ? value.trim() : value;
  }
  return answer;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Renders an integration OAuth failure as user-facing copy.
 *
 * Validation failures carry a message authored by the integration (a field
 * rule such as "URL or domain is required"); it is shown verbatim because only
 * the integration knows which input was rejected.
 */
export const describeOAuthError = (
  error: unknown,
  t: ProviderOAuthTranslator,
  fallbackKey: I18nKey,
): string => {
  const record: Record<string, unknown> = isRecord(error) ? error : {};
  const data: Record<string, unknown> = isRecord(record.data) ? record.data : {};

  switch (record.name) {
    case 'IntegrationOauthAttemptMissing':
      return t('settings.providers.page.auth.oauth.error.sessionExpired');
    case 'IntegrationOauthCodeMissing':
      return t('settings.providers.page.auth.oauth.error.codeRequired');
    case 'IntegrationOauthFailed':
      return t('settings.providers.page.auth.oauth.error.declined');
    case 'IntegrationValidationFailed':
      return asText(data.message) ?? t('settings.providers.page.auth.oauth.error.invalidInput');
    default:
      return asText(record.message) ?? t(fallbackKey);
  }
};
