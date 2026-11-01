import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';

/** The title of each zone, shared by the desktop's zone headers and the phone's. */
// The list by time holds every project's sessions, so it is titled Projects.
export const ACTIVITY_TITLE_KEY = {
  pinned: 'sessions.sidebar.activity.pinnedTitle',
  work: 'sessions.sidebar.work.title',
  chats: 'sessions.sidebar.activity.chatsTitle',
  timeline: 'sessions.sidebar.activity.projectsTitle',
} as const;

/** A built-in zone, titled from `ACTIVITY_TITLE_KEY`; the user's sections carry their own name. */
export const isBuiltinActivityKey = (key: SessionSidebarActivityKey): key is keyof typeof ACTIVITY_TITLE_KEY => (
  Object.hasOwn(ACTIVITY_TITLE_KEY, key)
);
