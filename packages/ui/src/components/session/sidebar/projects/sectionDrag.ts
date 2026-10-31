import type { SessionSidebarRow } from '../sessionSidebarRowModel';

export const SECTION_SORT_GROUP = 'sections';

/** The sortable id of a section's caption, apart from project ids. */
export const sectionDragId = (sectionId: string): string => `section-drag:${sectionId}`;

/**
 * The section a caption row opens, by its id in the user's list of sections:
 * the list by time is the Projects section grouped by time. Null for every
 * other row.
 */
export const sectionIdOfRow = (row: SessionSidebarRow): string | null => {
  const key = row.kind === 'activity-header' ? row.activityKey : row.kind === 'caption' ? row.caption : null;
  if (key === null) return null;
  if (key === 'timeline') return 'projects';
  return key.startsWith('section:') ? key.slice('section:'.length) : key;
};
