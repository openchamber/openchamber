import type { IconName } from '@/components/icon/icons';
import type { TrackerStateCategory } from './types';


type TrackerStateGlyph = { icon: IconName; color: string };

export const trackerStateGlyph = (category: TrackerStateCategory | null | undefined): TrackerStateGlyph => {
  switch (category) {
    case 'in-progress':
      return { icon: 'record-circle', color: 'var(--pr-open)' };
    case 'done':
      return { icon: 'checkbox-circle', color: 'var(--pr-merged)' };
    case 'canceled':
      return { icon: 'close-circle', color: 'var(--pr-closed)' };
    default:
      return { icon: 'checkbox-blank-circle', color: 'var(--surface-muted-foreground)' };
  }
};

type TrackerIssueLook = 'open' | 'completed' | 'not_planned';

export const trackerIssueLook = (category: TrackerStateCategory): TrackerIssueLook => {
  switch (category) {
    case 'done':
      return 'completed';
    case 'canceled':
      return 'not_planned';
    default:
      return 'open';
  }
};

export const isSettledTrackerState = (category: TrackerStateCategory | null | undefined): boolean => (
  category === 'done' || category === 'canceled'
);

const CATEGORY_RANK = {
  triage: 0,
  backlog: 1,
  todo: 2,
  'in-progress': 3,
  done: 4,
  canceled: 5,
} as const satisfies Record<TrackerStateCategory, number>;

export const trackerStateCategoryRank = (category: TrackerStateCategory | null | undefined): number => (
  category ? CATEGORY_RANK[category] : Object.keys(CATEGORY_RANK).length
);
