import type { TrackerStateCategory } from './types';

/**
 * Linear's shapes from before trackers, which older servers still send and
 * older clients still read. The web adapter's legacy `/api/linear` wire
 * (`packages/web/src/api/trackers-legacy-linear.ts`) and the stored and live
 * readers here use these tables, so both map a Linear state the same way.
 */

/** Linear's workflow state `type` to the neutral category; `duplicate` counts as canceled. */
const STATE_CATEGORY_BY_LINEAR_TYPE: ReadonlyMap<string, TrackerStateCategory> = new Map<string, TrackerStateCategory>([
  ['triage', 'triage'],
  ['backlog', 'backlog'],
  ['unstarted', 'todo'],
  ['started', 'in-progress'],
  ['completed', 'done'],
  ['canceled', 'canceled'],
  ['duplicate', 'canceled'],
]);

/** The neutral category of a Linear state type; null for a type this version does not know. */
export const linearStateCategory = (type: string | null | undefined): TrackerStateCategory | null => (
  type ? STATE_CATEGORY_BY_LINEAR_TYPE.get(type) ?? null : null
);

/**
 * The link kind stored for a tracker's items. Clients from before trackers read
 * only `kind: 'linear'`, and rewrite the list without any entry they cannot
 * read, so a Linear link keeps that kind (with `provider` beside it) while the
 * legacy `/api/linear` routes exist. Other trackers are `tracker`: older
 * clients cannot show them anyway.
 */
const LEGACY_LINK_KIND_BY_TRACKER: ReadonlyMap<string, 'linear'> = new Map([['linear', 'linear']]);

export const storedTrackerLinkKind = (provider: string): 'tracker' | 'linear' => (
  LEGACY_LINK_KIND_BY_TRACKER.get(provider) ?? 'tracker'
);
