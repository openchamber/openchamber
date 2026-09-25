import React from 'react';
import { GUEST_TOOL_TEMPLATE_VALUE_MAX, type GuestToolContribution, type JsonValue } from '@openchamber/sdk';
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
};

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

const PLACEHOLDER = /\{(input|output|metadata)((?:\.[A-Za-z0-9_-]+)*)\}/g;

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
  const needsOutput = Boolean(
    (rule.title && TEMPLATE_NEEDS_OUTPUT.test(rule.title))
    || (rule.subtitle && TEMPLATE_NEEDS_OUTPUT.test(rule.subtitle)),
  );
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
