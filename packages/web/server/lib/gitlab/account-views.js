export const accountView = (origin, account, current, accounts) => ({
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

export const cliAccountView = (origin, user, current) => ({
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
