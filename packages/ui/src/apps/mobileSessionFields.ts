import type { Session } from '@/lib/opencode/model';

import { normalizePath } from './mobilePaths';

/** Session field readers shared by the phone's sessions drawer and its rows. */

export const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};
