
import type { FormField, FormValue, FormWhen } from '@opencode/client';
import type { I18nKey, I18nParams } from '@/lib/i18n';

export type OAuthCompletionMode = 'auto' | 'code';

export type ProviderOAuthTranslator = (key: I18nKey, params?: I18nParams) => string;

export interface OAuthAttempt {
  attemptID: string;
  mode: OAuthCompletionMode;
  url: string;
  instructions: string;
  paste: boolean;
}

export const shouldOpenAuthorizationUrl = (providerId: string, url?: string): boolean =>
  Boolean(url) && providerId !== 'claude-code';

const DEVICE_CODE_PATTERN = /[A-Z0-9]{4}-[A-Z0-9]{4,5}/;

export const extractUserCode = (instructions: string): string | undefined =>
  DEVICE_CODE_PATTERN.exec(instructions)?.[0] ?? undefined;

type AnswerableField = Exclude<FormField, { type: 'external' }>;

export const isAnswerableField = (field: FormField): field is AnswerableField =>
  field.type !== 'external';

export const fieldLabel = (field: FormField): string => field.title ?? field.key;

const matchesCondition = (condition: FormWhen, value: FormValue | undefined): boolean => {
  if (value === undefined) return false;
  const current = String(value);
  const expected = String(condition.value);
  return condition.op === 'eq' ? current === expected : current !== expected;
};

export const isFieldVisible = (field: FormField, activeValues: Record<string, FormValue>): boolean => {
  if (!isAnswerableField(field)) return true;
  return (field.when ?? []).every((condition) => matchesCondition(condition, activeValues[condition.key]));
};

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

export const firstUnansweredField = (
  fields: readonly FormField[],
  values: Record<string, FormValue>,
): FormField | null =>
  visibleFields(fields, values).find(
    (field) => isAnswerableField(field) && field.required === true && isBlank(values[field.key]),
  ) ?? null;

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
