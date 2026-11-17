import type { GitIdentityProfile, SourceControlIdentity } from '@/lib/api/types';
import { isCompleteIdentity } from '@/lib/api/git-identity';
import { activeIdentityFor, identityAccountConnected, selectableIdentities } from '@/lib/source-control/identity';

export const offeredAuthors = (
  profiles: GitIdentityProfile[],
  globalIdentity: GitIdentityProfile | null,
  connectedAccountIds: (account: SourceControlIdentity) => string[] | null,
): GitIdentityProfile[] => selectableIdentities(profiles, globalIdentity,
  (identity) => isCompleteIdentity(identity) && identityAccountConnected(identity, connectedAccountIds));

export const activeAuthor = (
  profiles: GitIdentityProfile[],
  globalIdentity: GitIdentityProfile | null,
  currentIdentity: { userName?: string | null; userEmail?: string | null } | null | undefined,
  boundAccountId: string | null | undefined,
): GitIdentityProfile | null => activeIdentityFor(profiles, globalIdentity, currentIdentity, (author) => ({
  id: 'local-config', name: author.userName, ...author, color: 'info', icon: 'user',
}), boundAccountId);
