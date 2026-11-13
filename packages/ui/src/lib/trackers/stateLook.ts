import type { IconName } from '@/components/icon/icons';
import type { TrackerStateCategory } from './types';

/**
 * How a work item's state reads, by category. Trackers name their states per
 * team or project; the category is what maps onto the theme's PR colours.
 */

/** A glyph for a state in a list or a status menu: started is open, done is merged, dropped is closed, the rest is not started. */
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

/**
 * The repository-issue state a work item reads as on issue badges (sidebar,
 * work status): not done yet is open, done is completed, dropped is not
 * planned.
 */
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

/** Whether an item in this state is finished: nothing more moves it, so it is not followed. */
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

/** Where a category sorts in a status menu: the workflow's order, unknown last. */
export const trackerStateCategoryRank = (category: TrackerStateCategory | null | undefined): number => (
  category ? CATEGORY_RANK[category] : Object.keys(CATEGORY_RANK).length
);
