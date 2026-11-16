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

const loadOrSeedBaseline = (): Set<string> => {
  const known = loadSeenAnchors();
  if (known.size > 0) return known;
  const seeded = new Set(SETTINGS_ANCHOR_PAGES.keys());
  saveSeenAnchors([...seeded]);
  return seeded;
};

type NewSettingsBadgeState = {
  readonly newAnchors: ReadonlySet<string>;
  readonly pendingAnchors: ReadonlySet<string>;
};

const buildState = (): NewSettingsBadgeState => {
  const known = loadOrSeedBaseline();

  const newAnchors = new Set<string>();
  for (const anchorId of SETTINGS_ANCHOR_PAGES.keys()) {
    if (known.has(anchorId)) continue;
    newAnchors.add(anchorId);
  }
  return { newAnchors, pendingAnchors: newAnchors };
};

let state: NewSettingsBadgeState | null = null;

const resolveState = (): NewSettingsBadgeState => {
  if (!state) state = buildState();
  return state;
};

export const isNewSetting = (anchorId: string): boolean => resolveState().newAnchors.has(anchorId);

export const getNewSettingPages = (ctx: SettingsSearchAvailabilityContext): SettingsPageSlug[] => {
  const pending = resolveState().pendingAnchors;
  return [...new Set([...getAvailableSettingsAnchorPages(ctx)]
    .filter(([anchorId]) => pending.has(anchorId))
    .map(([, page]) => page))];
};

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

export const resetNewSettingsBadgeCacheForTests = (): void => {
  state = null;
};
