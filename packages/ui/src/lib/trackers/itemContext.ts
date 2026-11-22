import type { TrackerItem } from './types';

export function buildTrackerItemContextText(item: TrackerItem, trackerName: string): string {
  const { comments = [], commentsMore, ...fields } = item;
  // Only the first comments page reaches the agent; say so when more exist on
  // the tracker, so the newest discussion is never mistaken for all of it.
  const truncationNote = commentsMore === true
    ? `Note: only the first ${comments.length} comments are included; further comments exist on ${trackerName}.\n`
    : '';
  return `${trackerName} issue context (JSON)\n${truncationNote}${JSON.stringify({ item: fields, comments }, null, 2)}`;
}
