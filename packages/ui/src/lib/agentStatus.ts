import type { I18nKey, I18nParams, Locale } from '@/lib/i18n';

/**
 * What the agent is doing, as a dictionary key and its values; the text is
 * made in the reader's language when it is shown (`formatAgentStatus`). The
 * phrases live in `lib/i18n/messages/agent-status.i18n.ts`.
 */
export type AgentStatus = {
  key: I18nKey;
  /** Parallel calls of one kind, for a counted phrase (`*.count`). */
  count?: number;
  /** A tool or integration nobody described, read as words. */
  name?: string;
  /** The reasoning part behind "thinking", which keys its occasional joke. */
  seed?: string;
};

type Translate = (key: I18nKey, params?: I18nParams) => string;

const PLURAL = /\{count, plural,((?:[^{}]|\{[^{}]*\})*)\}/g;
const PLURAL_CASE = /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g;

/**
 * Resolves ICU `{count, plural, ...}` blocks for `locale`: an exact `=n`
 * case first, then the locale's plural category, then `other`. `#` becomes
 * the number in the locale's digits.
 */
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

/** The phrase alone, as the dictionary writes it ("running 3 commands"). */
export const formatAgentStatusPhrase = (t: Translate, locale: Locale, status: AgentStatus): string => {
  const raw = t(status.key);
  const counted = status.count === undefined ? raw : applyPlural(raw, status.count, locale);
  // A function, so `$&` or `$$` in a tool's name stay as written.
  return counted.replace(/\{name\}/g, () => status.name ?? '');
};

/**
 * The label the status row and the pill show: after the model's name when it
 * is known, else the phrase on its own with a capital first letter. `phrase`
 * replaces the dictionary's, for an easter-egg line said in its place.
 */
export const formatAgentStatus = (t: Translate, locale: Locale, status: AgentStatus, modelName?: string | null, phrase = formatAgentStatusPhrase(t, locale, status)): string => {
  const model = modelName?.trim() ?? '';
  if (model) return t('chat.statusRow.modelStatus', { model, status: phrase });
  return phrase.charAt(0).toLocaleUpperCase(locale) + phrase.slice(1);
};

/** A stable string for comparing statuses: equal statuses read the same in every language. */
export const agentStatusSignature = (status: AgentStatus): string => `${status.key}|${status.count ?? ''}|${status.name ?? ''}|${status.seed ?? ''}`;
