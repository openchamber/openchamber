import type {
  RepositoryReference,
  RepositoryReferenceDetail,
  SourceControlReadContext,
} from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { useCredentialScopes } from '@/hooks/useCredentialScopes';
import { useRepoCapabilities } from '@/hooks/useRepoCapabilities';
import { conversationActions } from './conversationActions';
import type { CachedValue } from './referenceCache';

export const useReferenceWriteState = ({
  reference,
  detail,
  descriptor,
  context,
  onWriteRefresh,
  onRefresh,
}: {
  reference: RepositoryReference;
  detail: CachedValue<RepositoryReferenceDetail>;
  descriptor: SourceControlProviderDescriptor;
  context?: SourceControlReadContext | null;
  onWriteRefresh?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
}) => {
  const assignees = reference.kind === 'issue' && detail.status === 'ready' ? detail.value.assignees ?? [] : [];
  const writeRefresh = onWriteRefresh ?? onRefresh;
  const writeAccess = detail.status === 'ready' ? detail.value.writeAccess : undefined;
  const followScopes = useCredentialScopes(context ?? null);
  const lockCapabilities = useRepoCapabilities(context ?? null);
  const conversation = conversationActions(reference, detail, context ?? null, followScopes, descriptor.features, lockCapabilities?.lock);
  const canChangeBase = reference.kind === 'pull' && reference.linked !== true && descriptor.features.baseChange && writeAccess !== false && context != null;
  return { assignees, writeRefresh, conversation, canChangeBase };
};
