import type { I18nKey, I18nParams, Locale } from '@/lib/i18n';

export type AgentStatus = {
  key: I18nKey;
  count?: number;
  name?: string;
  seed?: string;
};

type Translate = (key: I18nKey, params?: I18nParams) => string;

const PLURAL = /\{count, plural,((?:[^{}]|\{[^{}]*\})*)\}/g;
const PLURAL_CASE = /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g;

export const applyPlural = (template: string, count: number, locale: Locale): string => {
  const category = new Intl.PluralRules(locale).select(count);
  const number = new Intl.NumberFormat(locale).format(count);
  return template.replace(PLURAL, (_match, body: string) => {
    const cases = new Map<string, string>();
    for (const [, selector, text] of body.matchAll(PLURAL_CASE)) cases.set(selector, text);
    const chosen = cases.get(`=${count}`) ?? cases.get(category) ?? cases.get('other') ?? '';
    return chosen.replace(/#/g, number);
  });
};

export const formatAgentStatusPhrase = (t: Translate, locale: Locale, status: AgentStatus): string => {
  const raw = t(status.key);
  const counted = status.count === undefined ? raw : applyPlural(raw, status.count, locale);
  return counted.replace(/\{name\}/g, () => status.name ?? '');
};

export const formatAgentStatus = (t: Translate, locale: Locale, status: AgentStatus, modelName?: string | null, phrase = formatAgentStatusPhrase(t, locale, status)): string => {
  const model = modelName?.trim() ?? '';
  if (model) return t('chat.statusRow.modelStatus', { model, status: phrase });
  return phrase.charAt(0).toLocaleUpperCase(locale) + phrase.slice(1);
};

export const agentStatusSignature = (status: AgentStatus): string => `${status.key}|${status.count ?? ''}|${status.name ?? ''}|${status.seed ?? ''}`;
