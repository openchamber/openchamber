import type { PendingRequests } from './usePendingRequests';

/**
 * A session title carries the session's state, as in the desktop sidebar: a
 * finished turn nobody has seen and a request waiting on the user read
 * semibold, a running turn at full strength, the rest a step below. The open session
 * takes the selection's text colour, as on the desktop; where it is listed
 * again lower down (`repeat`), its fainter fill keeps the page's text colour.
 */
export const mobileSessionTitleClass = ({ active, repeat = false, unread, running, pending }: {
  active: boolean;
  repeat?: boolean;
  unread: boolean;
  running: boolean;
  pending: PendingRequests;
}): string => {
  if (active) return repeat ? 'text-foreground' : 'text-interactive-selection-foreground';
  if (unread || pending.hasPermission || pending.hasForm) return 'font-semibold text-foreground';
  return running ? 'text-foreground' : 'oc-title-rest';
};
