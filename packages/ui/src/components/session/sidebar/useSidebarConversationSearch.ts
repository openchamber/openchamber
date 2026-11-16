import * as React from 'react';

import { useConversationSearch, type ContentSearchStatus } from '@/hooks/useConversationSearch';
import type { ConversationMetadata } from '@/lib/search/conversationSearch';
import type { OmniAuthor, OmniSearchIn } from '@/lib/search/omniQuery';
import type { SearchResultSection } from './sessionSidebarRowModel';

type Options = {
  enabled: boolean;
  text: string;
  searchIn: OmniSearchIn;
  author: OmniAuthor;
  metadataItems: ReadonlyArray<ConversationMetadata>;
  directories?: readonly string[];
  isAdmitted: (directory: string | null) => boolean;
};

const NO_SECTIONS: ReadonlySet<SearchResultSection> = new Set();

/** One status for the field's mark: still loading while either block is, a failure of either, else both ready. */
function mergeContentSearchStatus(active: ContentSearchStatus, archived: ContentSearchStatus): ContentSearchStatus {
  if (active.kind === 'loading' || archived.kind === 'loading') return { kind: 'loading' };
  if (active.kind !== 'ready') return active;
  if (archived.kind !== 'ready') return archived;
  return {
    kind: 'ready',
    indexing: active.indexing ?? archived.indexing,
    lifecycleComplete: active.lifecycleComplete && archived.lifecycleComplete,
    hasMore: active.hasMore || archived.hasMore,
    pageError: Boolean(active.pageError || archived.pageError),
  };
}

/**
 * The sidebar's search: the active and the archived block each ask for their
 * own message matches and page on their own. One request for both lists the
 * newest matches first, so the archived ones, usually the oldest, would wait
 * pages below every active one.
 */
export function useSidebarConversationSearch({ metadataItems, ...shared }: Options) {
  const activeItems = React.useMemo(() => metadataItems.filter((item) => !item.archived), [metadataItems]);
  const archivedItems = React.useMemo(() => metadataItems.filter((item) => item.archived), [metadataItems]);
  const active = useConversationSearch({ ...shared, lifecycle: 'active', metadataItems: activeItems, branchOnly: true });
  const archived = useConversationSearch({ ...shared, lifecycle: 'archived', metadataItems: archivedItems, branchOnly: true });

  const results = React.useMemo(() => {
    // A conversation archived or restored a moment ago can still sit in the other block's
    // message matches. Its title match, or its first message match, is the one row it gets.
    const merged = [...active.results, ...archived.results];
    const listed = new Set(merged.flatMap((result) => (result.metadata ? [result.sessionId] : [])));
    return merged.filter((result) => {
      if (result.metadata) return true;
      if (listed.has(result.sessionId)) return false;
      listed.add(result.sessionId);
      return true;
    });
  }, [active.results, archived.results]);

  const contentStatus = React.useMemo(() => mergeContentSearchStatus(active.contentStatus, archived.contentStatus), [active.contentStatus, archived.contentStatus]);
  const activeHasMore = active.contentStatus.kind === 'ready' && active.contentStatus.hasMore;
  const archivedHasMore = archived.contentStatus.kind === 'ready' && archived.contentStatus.hasMore;
  const sectionsWithMore = React.useMemo((): ReadonlySet<SearchResultSection> => {
    if (!activeHasMore && !archivedHasMore) return NO_SECTIONS;
    return new Set<SearchResultSection>([...(activeHasMore ? ['active' as const] : []), ...(archivedHasMore ? ['archived' as const] : [])]);
  }, [activeHasMore, archivedHasMore]);
  const loadMoreActive = active.loadMore;
  const loadMoreArchived = archived.loadMore;
  const loadMore = React.useCallback((section: SearchResultSection) => (section === 'archived' ? loadMoreArchived() : loadMoreActive()), [loadMoreActive, loadMoreArchived]);
  const totalCount = active.totalCount === null || archived.totalCount === null ? null : active.totalCount + archived.totalCount;

  return { results, contentStatus, sectionsWithMore, loadMore, totalCount };
}
