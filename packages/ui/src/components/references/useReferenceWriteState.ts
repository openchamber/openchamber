import type { RepositoryReference, RepositoryReferenceDetail } from '@/lib/api/types';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { useCredentialScopes } from '@/hooks/useCredentialScopes';
import { useRepoCapabilities } from '@/hooks/useRepoCapabilities';

import { conversationActions } from './conversationActions';
import type { CachedValue } from './referenceCache';

type Features = { lock: boolean; subscription: boolean };

export const useReferenceWriteState = ({
  reference,
  detail,
  features,
  context,
  onWriteRefresh,
  onRefresh,
}: {
  reference: RepositoryReference;
  detail: CachedValue<RepositoryReferenceDetail>;
  features: Features;
  context?: SourceControlReadContext | null;
  onWriteRefresh?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
}) => {
  const writeRefresh = onWriteRefresh ?? onRefresh;
  const followScopes = useCredentialScopes(context ?? null);
  const lockCapabilities = useRepoCapabilities(context ?? null);
  const conversation = conversationActions(reference, detail, context ?? null, followScopes, features, lockCapabilities?.lock);
  return { writeRefresh, conversation };
};
