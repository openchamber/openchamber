import type { PendingRequests } from './usePendingRequests';

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
