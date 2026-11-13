import { joinProjectPath } from '@/lib/source-control/projectPath';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';

import { useLinkRepository } from './boardRepository';

/**
 * The repository a link points into, when it is not the project's: numbers are
 * per repository, so `#118826` beside `#102` reads as a broken number without
 * it. Null while the project's remotes are unknown, and for a link to no
 * repository.
 */
export const useOutsideRepository = (url: string | null, directory: string | null): string | null => {
  const urls = useRepositoryUrlMatcher();
  const item = url ? urls.match(url) : null;
  const repository = useLinkRepository(directory ?? '', url ?? '', { enabled: Boolean(item && directory) });
  if (!item || !directory || repository.status !== 'ready' || repository.owned) return null;
  return joinProjectPath(item.owner, item.repo);
};
