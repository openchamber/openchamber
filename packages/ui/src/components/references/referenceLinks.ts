import * as React from 'react';

import type { RepositoryReference } from '@/lib/api/types';
import { repositoryLinkContextOfUrl, type RepositoryLinkContext } from '@/lib/source-control/repositoryLinks';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';

export type ReferenceLinks = {
  repository: RepositoryLinkContext | null;
  directory: string | null;
  issuePrefix: string;
  changeRequestPrefix: string;
};

const NO_LINKS: ReferenceLinks = { repository: null, directory: null, issuePrefix: '#', changeRequestPrefix: '#' };

export const ReferenceLinksContext = React.createContext<ReferenceLinks>(NO_LINKS);

export function useReferenceLinks(directory: string | null, reference: RepositoryReference | null): ReferenceLinks {
  const urls = useRepositoryUrlMatcher();
  const provider = useSourceControlProvider(reference?.provider ?? null);
  const url = reference?.url ?? null;
  return React.useMemo(() => ({
    repository: url ? repositoryLinkContextOfUrl(url, urls) : null,
    directory,
    issuePrefix: provider.terminology.issuePrefix,
    changeRequestPrefix: provider.terminology.changeRequestPrefix,
  }), [directory, url, urls, provider]);
}
