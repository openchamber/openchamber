import type { RepositoryReference, RepositoryReferenceDetail } from '@/lib/api/types';
import type { SourceControlReadContext } from '@/lib/source-control/types';

import type { CachedValue } from './referenceCache';

export type ConversationActionState = {
  showLock: boolean;
  showSubscription: boolean;
  locked: boolean;
  subscribed: boolean;
};

export const conversationActions = (
  reference: RepositoryReference,
  detail: CachedValue<RepositoryReferenceDetail>,
  context: SourceControlReadContext | null | undefined,
  scopes: string[] | null,
  features: { lock: boolean; subscription: boolean },
  instanceLock?: boolean | null,
): ConversationActionState => {
  const writable = context !== null && context !== undefined && reference.linked !== true;
  const value = detail.status === 'ready' ? detail.value : null;
  return {
    showLock: writable && features.lock && instanceLock !== false && value?.locked !== undefined && value.writeAccess !== false,
    showSubscription: writable && features.subscription && value?.viewerSubscribed !== undefined
      && (scopes === null || scopes.includes('notifications')),
    locked: value?.locked === true,
    subscribed: value?.viewerSubscribed === true,
  };
};
