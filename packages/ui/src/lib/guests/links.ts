import React from 'react';
import { GUEST_ATTACH_URL_MAX, buildLinkUrl, type GuestLinkAction } from '@openchamber/sdk';

import { guestMay } from './capabilities.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

/**
 * What active extensions claim in chat messages (`contributes.links`), as
 * plain data: the chat's Markdown plugin takes it as an option, and streamdown
 * keys its parser cache by the options' JSON, so nothing here may be a RegExp.
 * Catalog order decides between two extensions claiming the same thing.
 */
export type GuestLinkRule = {
  guestId: string;
  action: GuestLinkAction;
  keys: string[];
  urls: {
    origin: string;
    identifierPattern: string;
    patterns: Array<{ path: string; query?: { name: string } }>;
    itemTemplate: string | null;
  } | null;
};

/** A click target: which extension, what it does, the identifier and the link it names. */
export type GuestLinkClaim = {
  guestId: string;
  action: GuestLinkAction;
  identifier: string;
  url?: string;
};

/** Only an extension that is on, fully approved and granted `links` claims anything. */
export const guestLinkRulesOf = (guests: readonly InstalledGuest[]): GuestLinkRule[] => guests.flatMap((guest) => (
  guest.links && guestMay(guest, 'links')
    ? [{ guestId: guest.id, action: guest.links.action, keys: guest.links.keys, urls: guest.links.urls }]
    : []
));

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `KEY-123` for every claimed key, bounded, as a whole word: nothing inside a
 * word, a path, a URL or a version (`a/DEMO-1`, `DEMO-1-old`, `DEMO-1.5`).
 */
export const guestIdentifierPattern = (rules: readonly GuestLinkRule[]): RegExp | null => {
  const keys = [...new Set(rules.flatMap((rule) => rule.keys))].sort((a, b) => b.length - a.length);
  if (keys.length === 0) return null;
  return new RegExp(String.raw`(?<![\p{L}\p{N}_/#@.\-])(?:${keys.map(escape).join('|')})-\d{1,16}(?![\p{L}\p{N}_\-]|\.\p{N})`, 'gu');
};

const identifierMatchers = new WeakMap<GuestLinkRule, RegExp | null>();

// What `{id}` may be (`urls.identifier`); `KEY-12` never fills a `number` template.
const fillsItemTemplate = (rule: GuestLinkRule, identifier: string): boolean => {
  if (!rule.urls) return false;
  let matcher = identifierMatchers.get(rule);
  if (matcher === undefined) {
    try {
      matcher = new RegExp(rule.urls.identifierPattern);
    } catch {
      matcher = null;
    }
    identifierMatchers.set(rule, matcher);
  }
  return matcher?.test(identifier) === true;
};

const itemUrlOf = (rule: GuestLinkRule, identifier: string): string | undefined => (
  rule.urls?.itemTemplate && fillsItemTemplate(rule, identifier)
    ? buildLinkUrl(rule.urls.origin, rule.urls.itemTemplate, identifier)
    : undefined
);

/**
 * The claim on an identifier the text pattern found: the first extension, in
 * catalog order, listing its key. A chip needs its link, so an `attach` claim
 * with none stays text.
 */
export const claimGuestIdentifier = (rules: readonly GuestLinkRule[], identifier: string): GuestLinkClaim | null => {
  const key = identifier.slice(0, identifier.lastIndexOf('-'));
  const rule = rules.find((candidate) => candidate.keys.includes(key));
  if (!rule) return null;
  const url = itemUrlOf(rule, identifier);
  if (url) return { guestId: rule.guestId, action: rule.action, identifier, url };
  return rule.action === 'attach' ? null : { guestId: rule.guestId, action: rule.action, identifier };
};

const compiled = new WeakMap<GuestLinkRule, Array<{ path: RegExp; query: string | null; identifier: RegExp }>>();

const compileRule = (rule: GuestLinkRule) => {
  const cached = compiled.get(rule);
  if (cached) return cached;
  let patterns: Array<{ path: RegExp; query: string | null; identifier: RegExp }> = [];
  if (rule.urls) {
    try {
      const identifier = new RegExp(rule.urls.identifierPattern);
      patterns = rule.urls.patterns.map((pattern) => ({ path: new RegExp(pattern.path), query: pattern.query?.name ?? null, identifier }));
    } catch {
      patterns = [];
    }
  }
  compiled.set(rule, patterns);
  return patterns;
};

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * The claim on a link: an https URL on a rule's origin exactly (port
 * included, no `www.` folding) whose path matches a compiled template. The URL
 * handed on keeps the path and only the template's own query parameter; one
 * longer than a guest item carries stays an ordinary link.
 */
export const claimGuestUrl = (rules: readonly GuestLinkRule[], href: string): GuestLinkClaim | null => {
  const url = rules.some((rule) => rule.urls) ? parseUrl(href.trim()) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password) return null;
  for (const rule of rules) {
    if (!rule.urls || url.origin !== rule.urls.origin) continue;
    for (const pattern of compileRule(rule)) {
      const match = pattern.path.exec(url.pathname);
      if (!match) continue;
      if (pattern.query === null) {
        const kept = `${url.origin}${url.pathname}`;
        if (match[1] && kept.length <= GUEST_ATTACH_URL_MAX) return { guestId: rule.guestId, action: rule.action, identifier: match[1], url: kept };
        continue;
      }
      const candidate = url.searchParams.get(pattern.query);
      if (!candidate || !pattern.identifier.test(candidate)) continue;
      const kept = `${url.origin}${url.pathname}?${new URLSearchParams([[pattern.query, candidate]]).toString()}`;
      if (kept.length > GUEST_ATTACH_URL_MAX) continue;
      return { guestId: rule.guestId, action: rule.action, identifier: candidate, url: kept };
    }
  }
  return null;
};

// The last rules handed out, by content: every chat part reads the same
// catalog, so one slot keeps one array while the rules stay the same.
type HandedOutRules = { key: string; rules: readonly GuestLinkRule[] };
let current: HandedOutRules = { key: '[]', rules: [] };
const stableRules = (rules: readonly GuestLinkRule[]): readonly GuestLinkRule[] => {
  const key = JSON.stringify(rules);
  if (key !== current.key) current = { key, rules };
  return current.rules;
};

const versions = new WeakMap<readonly GuestLinkRule[], number>();
let nextVersion = 1;
/**
 * A short mark that changes with the rules. Streamdown's root re-renders on
 * its content and `data-*` props, not on a new plugin list, so a message
 * already on screen re-parses when an extension starts or stops claiming
 * through this mark.
 */
export const guestLinksVersion = (rules: readonly GuestLinkRule[]): number => {
  let version = versions.get(rules);
  if (version === undefined) {
    version = nextVersion;
    nextVersion += 1;
    versions.set(rules, version);
  }
  return version;
};

/**
 * The rules of the extensions active now. The array keeps its identity while
 * the rules stay the same, so the chat's Markdown plugins keep theirs and no
 * catalog reload re-parses a transcript.
 */
export const useGuestLinkRules = (): readonly GuestLinkRule[] => {
  const guests = useGuestsStore((state) => state.guests);
  return React.useMemo(() => stableRules(guestLinkRulesOf(guests)), [guests]);
};
