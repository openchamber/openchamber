import React from 'react';

import type { ContentSearchStatus } from '@/hooks/useConversationSearch';
import { useI18n } from '@/lib/i18n';

export const SearchStatusLine: React.FC<{ status: ContentSearchStatus; count: number | null }> = ({ status, count }) => {
  const { t } = useI18n();
  const key = status.kind === 'loading' ? 'search.omni.status.searching' : status.kind === 'off' ? 'search.omni.status.off' : status.kind === 'unsupported' ? 'search.omni.status.unsupported' : status.kind === 'failed' ? 'search.omni.status.failed' : status.kind === 'error' || status.kind === 'ready' && status.pageError ? 'search.omni.status.error' : status.kind === 'too-short' ? 'search.omni.status.tooShort' : status.kind === 'ready' && status.indexing ? 'search.omni.status.indexing' : status.kind === 'ready' && !status.lifecycleComplete ? 'search.omni.status.lifecycleIncomplete' : status.kind === 'ready' ? 'search.omni.status.ready' : null;
  const countText = count === null ? '' : t(count === 1 ? 'search.omni.count.one' : 'search.omni.count.other', { count });
  const statusText = key ? t(key, status.kind === 'ready' && status.indexing ? status.indexing : {}) : '';
  return <div data-search-status-line role="status" aria-live="polite" title={statusText || undefined} className="flex h-5 shrink-0 items-center justify-between gap-2 truncate typography-micro text-muted-foreground"><span>{countText}</span><span className="truncate">{statusText}</span></div>;
};
