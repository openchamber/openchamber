import type { SessionSidebarRow } from '../sessionSidebarRowModel';

export const SECTION_SORT_GROUP = 'sections';

export const sectionDragId = (sectionId: string): string => `section-drag:${sectionId}`;

export const sectionIdOfRow = (row: SessionSidebarRow): string | null => {
  const key = row.kind === 'activity-header' ? row.activityKey : row.kind === 'caption' ? row.caption : null;
  if (key === null) return null;
  if (key === 'timeline') return 'projects';
  return key.startsWith('section:') ? key.slice('section:'.length) : key;
};
