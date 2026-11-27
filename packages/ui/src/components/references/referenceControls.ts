import type { RepositoryReference, RepositoryReferenceDetail } from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

import type { CachedValue } from './referenceCache';

export const canEditReferenceText = (
    reference: RepositoryReference,
    detail: CachedValue<RepositoryReferenceDetail>,
    features: SourceControlProviderDescriptor['features'],
    offered: boolean,
): boolean => offered
    && reference.linked !== true
    && detail.status === 'ready'
    && detail.value.viewerCanUpdate !== false
    && !(reference.bodyTruncated && detail.value.body === undefined)
    && (reference.kind === 'pull'
        ? features.changeRequestEdit
        : reference.kind === 'discussion'
            ? features.discussions
            : features.issueEdit);

export const canReplyToReference = (
    reference: RepositoryReference,
    detail: RepositoryReferenceDetail | null,
): boolean => reference.kind !== 'discussion'
    || (detail !== null && detail.discussion?.canComment !== false);
