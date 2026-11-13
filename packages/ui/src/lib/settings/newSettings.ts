import { z } from 'zod';

import type { SettingsPageSlug } from './metadata';
import { getAvailableSettingsAnchorPages, SETTINGS_ANCHOR_PAGES, type SettingsSearchAvailabilityContext } from './search';

const STORAGE_KEY = 'openchamber.settings.newBadgeSeen.v1';

const parseSeenAnchors = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

const loadSeenAnchors = (): Set<string> => {
  try {
    return new Set(parseSeenAnchors(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return new Set();
  }
};

const saveSeenAnchors = (anchorIds: readonly string[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(anchorIds));
  } catch {
    // Ignore storage failures; the badge simply reappears next time.
  }
};

/**
 * The anchors this client already knows. A client with no baseline is seeding
 * one for the first time, so the build's own anchors are what it knows; that is
 * what keeps a fresh install free of badges.
 */
const loadOrSeedBaseline = (): Set<string> => {
  const known = loadSeenAnchors();
  if (known.size > 0) return known;
  const seeded = new Set(SETTINGS_ANCHOR_PAGES.keys());
  saveSeenAnchors([...seeded]);
  return seeded;
};

type NewSettingsBadgeState = {
  /** The anchors that were new when this client loaded the badge. */
  readonly newAnchors: ReadonlySet<string>;
  readonly pendingAnchors: ReadonlySet<string>;
};

/**
 * What this client has not seen yet: the anchors the running build has that its
 * baseline lacks, whatever number of releases that spans.
 */
const buildState = (): NewSettingsBadgeState => {
  const known = loadOrSeedBaseline();

  const newAnchors = new Set<string>();
  for (const anchorId of SETTINGS_ANCHOR_PAGES.keys()) {
    if (known.has(anchorId)) continue;
    newAnchors.add(anchorId);
  }
  return { newAnchors, pendingAnchors: newAnchors };
};

/**
 * Resolved once and kept in memory: deciding what is new walks the whole search
 * table, and the answer only changes when the user acknowledges it. Reading it
 * again on every row render would repeat that walk for nothing.
 */
let state: NewSettingsBadgeState | null = null;

const resolveState = (): NewSettingsBadgeState => {
  if (!state) state = buildState();
  return state;
};

/** Whether the control at `anchorId` is new to this client. Unknown anchors never are. */
export const isNewSetting = (anchorId: string): boolean => resolveState().newAnchors.has(anchorId);

/** The pages whose nav item still carries the badge, in search-table order. */
export const getNewSettingPages = (ctx: SettingsSearchAvailabilityContext): SettingsPageSlug[] => {
  const pending = resolveState().pendingAnchors;
  return [...new Set([...getAvailableSettingsAnchorPages(ctx)]
    .filter(([anchorId]) => pending.has(anchorId))
    .map(([, page]) => page))];
};

/**
 * Acknowledge one page: the baseline moves past that page's anchors, and the
 * pages the user has not opened keep their badge.
 *
 * `newAnchors` keeps the answer resolved at load, so the page the user just
 * opened still shows which of its controls are new; the next load reads the
 * moved baseline and shows none of them.
 */
export const acknowledgeNewSettingPage = (page: SettingsPageSlug, ctx: SettingsSearchAvailabilityContext): void => {
  const current = resolveState();
  if (!getNewSettingPages(ctx).includes(page)) return;

  const seen = loadOrSeedBaseline();
  const pendingAnchors = new Set(current.pendingAnchors);
  for (const [anchorId, anchorPage] of getAvailableSettingsAnchorPages(ctx)) {
    if (anchorPage !== page) continue;
    seen.add(anchorId);
    pendingAnchors.delete(anchorId);
  }
  saveSeenAnchors([...seen]);

  state = {
    newAnchors: current.newAnchors,
    pendingAnchors,
  };
};

/** Drop the resolved answer so the next read rebuilds it. Tests use it after writing storage directly. */
export const resetNewSettingsBadgeCacheForTests = (): void => {
  state = null;
};
