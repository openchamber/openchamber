import * as React from 'react';

import type { RepositoryReference } from '@/lib/api/types';
import { repositoryLinkContextOfUrl, type RepositoryLinkContext } from '@/lib/source-control/repositoryLinks';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';

/**
 * What the Markdown bodies inside one preview link against: the item's
 * repository, for `#12`, `@someone` and commit ids, and the folder the item
 * was read through, where a commit link looks for that commit first.
 */
export type ReferenceLinks = { repository: RepositoryLinkContext | null; directory: string | null };

const NO_LINKS: ReferenceLinks = { repository: null, directory: null };

export const ReferenceLinksContext = React.createContext<ReferenceLinks>(NO_LINKS);

/** One stable value per item and folder, so bodies keep their parsed Markdown across renders. */
export function useReferenceLinks(directory: string | null, reference: RepositoryReference | null): ReferenceLinks {
  const urls = useRepositoryUrlMatcher();
  const url = reference?.url ?? null;
  return React.useMemo(() => ({
    repository: url ? repositoryLinkContextOfUrl(url, urls) : null,
    directory,
  }), [directory, url, urls]);
}
