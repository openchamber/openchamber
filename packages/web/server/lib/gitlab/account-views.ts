import type { AuthCredential } from '../source-control/auth-storage.js';
import type { GitLabUser } from './user.js';

export const accountView = (origin: string, account: AuthCredential, current: boolean, accounts: readonly AuthCredential[]) => ({
  id: account.id,
  credentialId: account.id,
  credentialRevision: account.credentialRevision,
  providerUserId: account.providerUserId,
  providerUserStatus: accounts.some((candidate) => (
    candidate.providerUserId === account.providerUserId && candidate.status === 'valid'
  )) ? 'available' : 'unavailable',
  user: { ...account.user, provider: 'gitlab', instance: origin },
  scope: account.scope,
  current,
  source: account.source,
  status: account.status === 'invalid' ? 'invalid' : 'valid',
});

export const cliAccountView = (origin: string, user: GitLabUser, current: boolean) => ({
  id: `${origin}#cli:${user.id}`,
  credentialId: `${origin}#cli:${user.id}`,
  credentialRevision: 1,
  providerUserId: `${origin}#${user.id}`,
  providerUserStatus: 'available',
  user: { ...user, provider: 'gitlab', instance: origin },
  current,
  source: 'cli',
  status: 'valid',
});
