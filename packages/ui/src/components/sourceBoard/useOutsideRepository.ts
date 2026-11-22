import { joinProjectPath } from '@/lib/source-control/projectPath';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';

import { useLinkRepository } from './boardRepository';

export const useOutsideRepository = (url: string | null, directory: string | null): string | null => {
  const urls = useRepositoryUrlMatcher();
  const item = url ? urls.match(url) : null;
  const repository = useLinkRepository(directory ?? '', url ?? '', { enabled: Boolean(item && directory) });
  if (!item || !directory || repository.status !== 'ready' || repository.owned) return null;
  return joinProjectPath(item.owner, item.repo);
};
