import type { TrackerItem } from './types';

/**
 * What an agent receives for an attached work item: a header naming the
 * tracker, then the item and its comments as indented JSON in the neutral
 * tracker shape, so every tracker produces the same format. The item's own
 * `comments` move to the top-level list instead of being sent twice.
 */
export function buildTrackerItemContextText(item: TrackerItem, trackerName: string): string {
  const { comments = [], ...fields } = item;
  return `${trackerName} issue context (JSON)\n${JSON.stringify({ item: fields, comments }, null, 2)}`;
}
