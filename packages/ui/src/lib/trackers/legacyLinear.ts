import type { TrackerStateCategory } from './types';


const STATE_CATEGORY_BY_LINEAR_TYPE: ReadonlyMap<string, TrackerStateCategory> = new Map<string, TrackerStateCategory>([
  ['triage', 'triage'],
  ['backlog', 'backlog'],
  ['unstarted', 'todo'],
  ['started', 'in-progress'],
  ['completed', 'done'],
  ['canceled', 'canceled'],
  ['duplicate', 'canceled'],
]);

export const linearStateCategory = (type: string | null | undefined): TrackerStateCategory | null => (
  type ? STATE_CATEGORY_BY_LINEAR_TYPE.get(type) ?? null : null
);

const LEGACY_LINK_KIND_BY_TRACKER: ReadonlyMap<string, 'linear'> = new Map([['linear', 'linear']]);

export const storedTrackerLinkKind = (provider: string): 'tracker' | 'linear' => (
  LEGACY_LINK_KIND_BY_TRACKER.get(provider) ?? 'tracker'
);
