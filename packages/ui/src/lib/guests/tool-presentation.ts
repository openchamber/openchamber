import React from 'react';
import {
  GUEST_TOOL_CARD_TEMPLATE_ROOTS,
  GUEST_TOOL_CARD_URL_MAX,
  GUEST_TOOL_TEMPLATE_ROOTS,
  GUEST_TOOL_TEMPLATE_VALUE_MAX,
  guestToolPlaceholderPattern,
  type GuestTone,
  type GuestToolCard,
  type GuestToolContribution,
  type JsonValue,
} from '@openchamber/sdk';
import type { ToolInput } from '@/lib/opencode/model';

import { isGuestActive } from './capabilities.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

export type GuestToolRule = GuestToolContribution & {
  guestId: string;
  prefix: string;
  wildcard: boolean;
  linkSettings: Readonly<Record<string, string>>;
};

const NO_LINK_SETTINGS: Readonly<Record<string, string>> = Object.freeze({});

const EMPTY_RULES: GuestToolRule[] = [];

export const compileGuestToolRules = (guests: readonly InstalledGuest[]): GuestToolRule[] => {
  const rules: GuestToolRule[] = [];
  for (const guest of guests) {
    if (!isGuestActive(guest) || !guest.tools?.length) continue;
    for (const tool of guest.tools) {
      const wildcard = tool.match.endsWith('*');
      rules.push({
        ...tool,
        guestId: guest.id,
        prefix: wildcard ? tool.match.slice(0, -1) : tool.match,
        wildcard,
        linkSettings: guest.toolLinkSettings ?? NO_LINK_SETTINGS,
      });
    }
  }
  return rules.length > 0 ? rules : EMPTY_RULES;
};

export const matchGuestToolRule = (rules: readonly GuestToolRule[], fullToolName: string): GuestToolRule | null => {
  let wildcardHit: GuestToolRule | null = null;
  for (const rule of rules) {
    if (rule.wildcard) {
      if (!wildcardHit && fullToolName.startsWith(rule.prefix)) wildcardHit = rule;
      continue;
    }
    if (rule.prefix === fullToolName) return rule;
  }
  return wildcardHit;
};

let cachedGuests: readonly InstalledGuest[] | null = null;
let cachedRules: GuestToolRule[] = EMPTY_RULES;

const rulesForCatalog = (guests: readonly InstalledGuest[]): GuestToolRule[] => {
  if (guests !== cachedGuests) {
    cachedGuests = guests;
    cachedRules = compileGuestToolRules(guests);
  }
  return cachedRules;
};

export const resolveGuestToolPresentation = (fullToolName: string | undefined | null): GuestToolRule | null => {
  if (!fullToolName) return null;
  const rules = rulesForCatalog(useGuestsStore.getState().guests);
  return rules.length === 0 ? null : matchGuestToolRule(rules, fullToolName);
};

export const useGuestToolPresentation = (fullToolName: string | undefined | null): GuestToolRule | null => {
  const guests = useGuestsStore((state) => state.guests);
  return React.useMemo(() => {
    if (!fullToolName) return null;
    const rules = rulesForCatalog(guests);
    return rules.length === 0 ? null : matchGuestToolRule(rules, fullToolName);
  }, [guests, fullToolName]);
};

type TemplateValue = JsonValue | undefined;

const isJsonArray = (value: TemplateValue): value is JsonValue[] => Array.isArray(value);

const isJsonObject = (value: TemplateValue): value is { [key: string]: JsonValue } => (
  value !== undefined && value !== null && !Array.isArray(value) && Object(value) === value
);

export const readPath = (value: TemplateValue, path: string): TemplateValue => {
  if (path === '') return value;
  let current: TemplateValue = value;
  for (const segment of path.split('.')) {
    if (isJsonArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      current = index >= 0 ? current[index] : undefined;
      continue;
    }
    if (!isJsonObject(current)) return undefined;
    current = Object.hasOwn(current, segment) ? current[segment] : undefined;
  }
  return current;
};

export const stringifyTemplateValue = (value: TemplateValue, max: number = GUEST_TOOL_TEMPLATE_VALUE_MAX): string => {
  let text: string;
  if (value === undefined || value === null) {
    text = '';
  } else if (String(value) === value) {
    text = value;
  } else if (isJsonArray(value) || isJsonObject(value)) {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

type TemplateContext = {
  input: TemplateValue;
  output: TemplateValue;
  metadata: TemplateValue;
};

const PLACEHOLDER = guestToolPlaceholderPattern(GUEST_TOOL_TEMPLATE_ROOTS);

export const renderTemplate = (template: string, context: TemplateContext): string => (
  template.replace(PLACEHOLDER, (_match, root: keyof TemplateContext, rest: string) => (
    stringifyTemplateValue(readPath(context[root], rest.startsWith('.') ? rest.slice(1) : rest))
  )).trim()
);

const TEMPLATE_NEEDS_OUTPUT = /\{output(?:\.|\})/;

export const guestToolHeaderReadsOutput = (rule: GuestToolRule): boolean => Boolean(
  (rule.title && TEMPLATE_NEEDS_OUTPUT.test(rule.title))
  || (rule.subtitle && TEMPLATE_NEEDS_OUTPUT.test(rule.subtitle)),
);

const templateOutputValue = (output: string | undefined): TemplateValue => {
  if (!output) return undefined;
  const trimmed = output.trim();
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}')) && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return output;
  }
  try {
    const parsed: JsonValue = JSON.parse(trimmed);
    return parsed;
  } catch {
    return output;
  }
};

type ToolStateData = ToolInput;

type GuestToolHeader = {
  title: string | null;
  subtitle: string | null;
};

export const renderGuestToolHeader = (
  rule: GuestToolRule,
  data: { input: ToolStateData | undefined; output: string | undefined; metadata: ToolStateData | undefined },
): GuestToolHeader => {
  const needsOutput = guestToolHeaderReadsOutput(rule);
  const context: TemplateContext = {
    input: data.input,
    output: needsOutput ? templateOutputValue(data.output) : undefined,
    metadata: data.metadata,
  };
  const renderedTitle = rule.title ? renderTemplate(rule.title, context) : '';
  const renderedSubtitle = rule.subtitle ? renderTemplate(rule.subtitle, context) : '';
  return {
    title: renderedTitle || rule.name || null,
    subtitle: renderedSubtitle || null,
  };
};

export const guestToolTableRows = (output: TemplateValue): JsonValue[] | null => {
  if (isJsonArray(output)) return output;
  if (isJsonObject(output)) {
    const items = output.items;
    if (isJsonArray(items)) return items;
  }
  return null;
};

export const GUEST_TOOL_CARD_ROWS_MAX = 200;

const CARD_PLACEHOLDER = guestToolPlaceholderPattern(GUEST_TOOL_CARD_TEMPLATE_ROOTS);

const cardScalar = (value: TemplateValue): string | null => {
  if (String(value) === value) return value.trim() === '' ? null : value;
  return Number(value) === value || Boolean(value) === value ? String(value) : null;
};

const renderCardText = (template: string, output: TemplateValue): string | null => {
  let resolved = false;
  const text = template.replace(PLACEHOLDER, (written, root: string, rest: string) => {
    if (root !== 'output') return written;
    const value = cardScalar(readPath(output, rest.slice(1)));
    if (value === null) return '';
    resolved = true;
    return stringifyTemplateValue(value);
  }).trim();
  return resolved && text !== '' ? text : null;
};

export const safeHttpsAddress = (address: string): string | null => {
  if (address.length > GUEST_TOOL_CARD_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  return url.href.length > GUEST_TOOL_CARD_URL_MAX ? null : url.href;
};

const writtenPathSteps = (address: string): string[] => (
  (/^https:\/\/[^/\\?#]*([^?#]*)/i.exec(address)?.[1] ?? '').split(/[/\\]/)
);

const isDotStep = (step: string): boolean => /^(?:\.|%2e){1,2}$/i.test(step);

export const renderGuestToolLinkUrl = (
  template: string,
  data: { output: TemplateValue; settings: Readonly<Record<string, string>> },
): string | null => {
  const whole = [...template.matchAll(CARD_PLACEHOLDER)];
  if (whole.length === 1 && whole[0]?.[0] === template) {
    const value = whole[0][1] === 'output' ? readPath(data.output, (whole[0][2] ?? '').slice(1)) : undefined;
    return String(value) === value ? safeHttpsAddress(value.trim()) : null;
  }
  let missing = whole.length === 0;
  const address = template.replace(CARD_PLACEHOLDER, (_written, root: string, rest: string) => {
    const path = rest.slice(1);
    let value: string | null = null;
    if (root === 'output') value = cardScalar(readPath(data.output, path));
    else if (root === 'settings' && Object.hasOwn(data.settings, path)) value = cardScalar(data.settings[path]);
    if (value === null) {
      missing = true;
      return '';
    }
    try {
      return encodeURIComponent(value.trim());
    } catch {
      missing = true;
      return '';
    }
  });
  if (missing || writtenPathSteps(address).some(isDotStep)) return null;
  return safeHttpsAddress(address);
};

export type GuestToolCardView = {
  label: string | null;
  title: string | null;
  status: { text: string; tone: GuestTone } | null;
  fields: { label: string; value: string }[];
  link: { label: string; url: string } | null;
};

export type GuestToolCardResult =
  | { kind: 'card'; card: GuestToolCardView }
  | { kind: 'list'; rows: GuestToolCardView[]; hidden: number };

const cardView = (
  card: GuestToolCard,
  output: TemplateValue,
  settings: Readonly<Record<string, string>>,
  withLink: boolean,
): GuestToolCardView | null => {
  const label = card.label ? renderCardText(card.label, output) : null;
  const title = card.title ? renderCardText(card.title, output) : null;
  const statusText = card.status ? renderCardText(card.status.value, output) : null;
  const tones = card.status?.tones;
  const fields: GuestToolCardView['fields'] = [];
  for (const field of card.fields ?? []) {
    const value = renderCardText(field.value, output);
    if (value !== null) fields.push({ label: field.label, value });
  }
  if (label === null && title === null && statusText === null && fields.length === 0) return null;
  const url = withLink && card.link ? renderGuestToolLinkUrl(card.link.url, { output, settings }) : null;
  return {
    label,
    title,
    status: statusText === null ? null : {
      text: statusText,
      tone: tones && Object.hasOwn(tones, statusText) ? tones[statusText] ?? 'neutral' : 'neutral',
    },
    fields,
    link: url !== null && card.link ? { label: card.link.label, url } : null,
  };
};

export const resolveGuestToolCard = (rule: GuestToolRule, output: TemplateValue): GuestToolCardResult | null => {
  if (!rule.card) return null;
  const items = guestToolTableRows(output);
  if (!items) {
    if (!isJsonObject(output)) return null;
    const card = cardView(rule.card, output, rule.linkSettings, true);
    return card ? { kind: 'card', card } : null;
  }
  const rows: GuestToolCardView[] = [];
  for (const item of items.slice(0, GUEST_TOOL_CARD_ROWS_MAX)) {
    const row = cardView(rule.card, item, rule.linkSettings, false);
    if (row) rows.push(row);
  }
  return rows.length > 0 ? { kind: 'list', rows, hidden: Math.max(0, items.length - GUEST_TOOL_CARD_ROWS_MAX) } : null;
};
