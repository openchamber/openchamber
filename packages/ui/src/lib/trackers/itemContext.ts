import type { TrackerItem } from './types';

export function buildTrackerItemContextText(item: TrackerItem, trackerName: string): string {
  const { comments = [], ...fields } = item;
  return `${trackerName} issue context (JSON)\n${JSON.stringify({ item: fields, comments }, null, 2)}`;
}
