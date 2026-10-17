import type { PendingRequests } from './usePendingRequests';

/**
 * A session title carries the session's state, as in the desktop sidebar: a
 * finished turn nobody has seen and a request waiting on the user read
 * semibold, a running turn at full strength, the rest muted. The open session
 * keeps its primary color.
 */
export const mobileSessionTitleClass = ({ active, unread, running, pending }: {
  active: boolean;
  unread: boolean;
  running: boolean;
  pending: PendingRequests;
}): string => {
  if (active) return 'text-primary';
  if (unread || pending.hasPermission || pending.hasForm) return 'font-semibold text-foreground';
  return running ? 'text-foreground' : 'text-muted-foreground';
};
