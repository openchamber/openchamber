import type { GitIdentityProfile, SourceControlIdentity } from '@/lib/api/types';
import { isCompleteIdentity } from '@/lib/api/git-identity';
import { activeIdentityFor, identityAccountConnected, selectableIdentities } from '@/lib/source-control/identity';

/** The authors the Git view offers: complete identities whose account is still connected, after the global one. */
export const offeredAuthors = (
  profiles: GitIdentityProfile[],
  globalIdentity: GitIdentityProfile | null,
  connectedAccountIds: (account: SourceControlIdentity) => string[] | null,
): GitIdentityProfile[] => selectableIdentities(profiles, globalIdentity,
  (identity) => isCompleteIdentity(identity) && identityAccountConnected(identity, connectedAccountIds));

/** The author the repository commits as; an author that matches no stored identity shows as a local one. */
export const activeAuthor = (
  profiles: GitIdentityProfile[],
  globalIdentity: GitIdentityProfile | null,
  currentIdentity: { userName?: string | null; userEmail?: string | null } | null | undefined,
  boundAccountId: string | null | undefined,
): GitIdentityProfile | null => activeIdentityFor(profiles, globalIdentity, currentIdentity, (author) => ({
  id: 'local-config', name: author.userName, ...author, color: 'info', icon: 'user',
}), boundAccountId);
