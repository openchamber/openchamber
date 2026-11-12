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

/** One `contributes.tools` entry of an active guest, compiled for matching. */
export type GuestToolRule = GuestToolContribution & {
  guestId: string;
  /** `match` without its trailing `*`; the whole name for an exact rule. */
  prefix: string;
  wildcard: boolean;
  /** The guest's setting values a card link reads as `{settings.<id>}`. */
  linkSettings: Readonly<Record<string, string>>;
};

const NO_LINK_SETTINGS: Readonly<Record<string, string>> = Object.freeze({});

const EMPTY_RULES: GuestToolRule[] = [];

/**
 * The tool rules of active (enabled and fully approved) guests, in catalog
 * order. Pure: the store hook and the plain resolver below both memoize on
 * the catalog array identity, so this runs once per catalog change, not per
 * rendered tool part.
 */
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

/**
 * The rule for a tool name as OpenCode reports it, un-normalized. An exact
 * rule beats a wildcard from any extension; among equals, the first
 * extension in the catalog (and its first rule) wins. `null` without a match.
 */
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

/** Store read outside React. Same memo as the hook. */
export const resolveGuestToolPresentation = (fullToolName: string | undefined | null): GuestToolRule | null => {
  if (!fullToolName) return null;
  const rules = rulesForCatalog(useGuestsStore.getState().guests);
  return rules.length === 0 ? null : matchGuestToolRule(rules, fullToolName);
};

/**
 * The rule for one rendered tool part. Subscribes to the catalog array only,
 * which changes on load, install, pause, approval, and runtime switch, never
 * while a tool streams. VS Code and mobile keep the store empty, so this is
 * `null` there.
 */
export const useGuestToolPresentation = (fullToolName: string | undefined | null): GuestToolRule | null => {
  const guests = useGuestsStore((state) => state.guests);
  return React.useMemo(() => {
    if (!fullToolName) return null;
    const rules = rulesForCatalog(guests);
    return rules.length === 0 ? null : matchGuestToolRule(rules, fullToolName);
  }, [guests, fullToolName]);
};

/** Template data is JSON: tool input, metadata, and output all arrive as JSON over the OpenCode SDK. */
type TemplateValue = JsonValue | undefined;

const isJsonArray = (value: TemplateValue): value is JsonValue[] => Array.isArray(value);

const isJsonObject = (value: TemplateValue): value is { [key: string]: JsonValue } => (
  value !== undefined && value !== null && !Array.isArray(value) && Object(value) === value
);

/**
 * Reads a dotted path (`items.0.title`) off JSON. An empty path is the value
 * itself. Any missing step, a step into a scalar, or an inherited key is
 * `undefined`.
 */
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

/** A placeholder value as text: strings as they are, JSON otherwise, empty for nothing, capped. */
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

/**
 * Substitutes `{input.path}` / `{output.path}` / `{metadata.path}` in a
 * declared template. Plain text replacement, no evaluation: a missing path
 * is an empty string and anything that is not one of the three roots stays
 * as written.
 */
export const renderTemplate = (template: string, context: TemplateContext): string => (
  template.replace(PLACEHOLDER, (_match, root: keyof TemplateContext, rest: string) => (
    stringifyTemplateValue(readPath(context[root], rest.startsWith('.') ? rest.slice(1) : rest))
  )).trim()
);

const TEMPLATE_NEEDS_OUTPUT = /\{output(?:\.|\})/;

/** Whether the rule's header reads the call's output, which a collapsed row then needs. */
export const guestToolHeaderReadsOutput = (rule: GuestToolRule): boolean => Boolean(
  (rule.title && TEMPLATE_NEEDS_OUTPUT.test(rule.title))
  || (rule.subtitle && TEMPLATE_NEEDS_OUTPUT.test(rule.subtitle)),
);

/** A tool's text output as template data: parsed JSON when it is JSON, else the text. */
const templateOutputValue = (output: string | undefined): TemplateValue => {
  if (!output) return undefined;
  const trimmed = output.trim();
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}')) && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return output;
  }
  try {
    // JSON.parse yields JSON by construction; its `any` result lands on the JSON type.
    const parsed: JsonValue = JSON.parse(trimmed);
    return parsed;
  } catch {
    return output;
  }
};

/**
 * Tool input and metadata as the domain model types them. `ToolInput` and
 * `Metadata` are both `Record<string, JsonValue>`, so a tool part's input and
 * metadata already are template values and need no assertion.
 */
type ToolStateData = ToolInput;

type GuestToolHeader = {
  title: string | null;
  subtitle: string | null;
};

/**
 * The header text a rule asks for. `title` is the rendered template when it
 * has one and it renders non-empty, else `name`, else `null` (the host's own
 * display name). `subtitle` is the rendered template or `null`. The output is
 * only parsed when a template mentions it.
 */
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

/** Rows for `output: "table"`: the parsed output array, or its `items` array. `null` when neither. */
export const guestToolTableRows = (output: TemplateValue): JsonValue[] | null => {
  if (isJsonArray(output)) return output;
  if (isJsonObject(output)) {
    const items = output.items;
    if (isJsonArray(items)) return items;
  }
  return null;
};

/** Rows drawn for a list; the rest is a count line, as in a table. */
export const GUEST_TOOL_CARD_ROWS_MAX = 200;

const CARD_PLACEHOLDER = guestToolPlaceholderPattern(GUEST_TOOL_CARD_TEMPLATE_ROOTS);

/**
 * A value a card or a link can show: text that is not blank, a number or a
 * boolean. Nothing, a blank string, an object and an array are all "missing":
 * the JSON text of an object has no place in a card.
 */
const cardScalar = (value: TemplateValue): string | null => {
  if (String(value) === value) return value.trim() === '' ? null : value;
  return Number(value) === value || Boolean(value) === value ? String(value) : null;
};

/**
 * One card template over one output. `null` when none of its placeholders
 * resolves, which hides the part; a placeholder that misses beside one that
 * resolves renders as nothing, the way it does in a title.
 */
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

/**
 * An address the host may put in an `href`: it parses, it is `https`, it
 * carries no user name or password, and it is not longer than a link may be.
 * Returns the address as the parser wrote it, so what was checked is what
 * opens. `null` otherwise.
 */
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

// What the manifest wrote between the host and the query, as its steps. The
// substituted values are percent-encoded, so every separator is the template's.
const writtenPathSteps = (address: string): string[] => (
  (/^https:\/\/[^/\\?#]*([^?#]*)/i.exec(address)?.[1] ?? '').split(/[/\\]/)
);

const isDotStep = (step: string): boolean => /^(?:\.|%2e){1,2}$/i.test(step);

/**
 * The address of a card's link, or `null` for no link. A template that is one
 * placeholder takes the output's own address as it is. Anything longer is an
 * address the manifest wrote around values: each value is percent-encoded, so
 * it stays inside the step, the query value or the host label it was written
 * into, and a value that would walk the path (`..`) gives no link. Every
 * placeholder has to resolve, and the finished address passes
 * `safeHttpsAddress`.
 */
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
      // A lone surrogate has no percent-encoding.
      missing = true;
      return '';
    }
  });
  if (missing || writtenPathSteps(address).some(isDotStep)) return null;
  return safeHttpsAddress(address);
};

/** One card, or one row of a list, with the parts that resolved. */
export type GuestToolCardView = {
  label: string | null;
  title: string | null;
  status: { text: string; tone: GuestTone } | null;
  fields: { label: string; value: string }[];
  link: { label: string; url: string } | null;
};

export type GuestToolCardResult =
  | { kind: 'card'; card: GuestToolCardView }
  /** `hidden` counts the output items past the row cap. */
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

/**
 * What `output: "card"` draws for a parsed output: one card for an object, a
 * list for an array or an `items` array, one row per item from the same
 * templates with `output` bound to the item. `null` when there is nothing to
 * draw (not JSON data, no part of the card resolves, no row does), and the
 * caller then shows the output the way it would without the rule. A list row
 * carries no link.
 */
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
