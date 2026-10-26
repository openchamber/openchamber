/** The icon and title of each zone, shared by the desktop's zone headers and the phone's. */
// The list by time holds every project's sessions, so it is titled Projects;
// its clock icon says how it is ordered.
export const ACTIVITY_ICON = { pinned: 'pushpin', work: 'eye', chats: 'chat-4', timeline: 'history' } as const;
export const ACTIVITY_TITLE_KEY = {
  pinned: 'sessions.sidebar.activity.pinnedTitle',
  work: 'sessions.sidebar.work.title',
  chats: 'sessions.sidebar.activity.chatsTitle',
  timeline: 'sessions.sidebar.activity.projectsTitle',
} as const;
