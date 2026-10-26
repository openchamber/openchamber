import { describe, expect, test } from 'bun:test';
import type { GitIdentityProfile } from '@/lib/api/types';
import { activeAuthor, offeredAuthors } from './gitAuthors';

const globalIdentity: GitIdentityProfile = { id: 'global', name: 'Global', userName: 'Global Author', userEmail: 'global@example.com' };
const account = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1' } as const;
const work: GitIdentityProfile = { id: 'work', name: 'Work', userName: 'Work Author', userEmail: 'work@example.com', account, transport: 'account' };
const signed: GitIdentityProfile = {
  id: 'signed', name: 'Signed author', userName: 'Signed Author', userEmail: 'signed@example.com',
  account, transport: 'account', signCommits: true, signingKey: '/public/signing.pub',
};
const plain: GitIdentityProfile = { id: 'plain', name: 'Author', userName: 'Plain Author', userEmail: 'plain@example.com', account, transport: 'account' };
const incomplete: GitIdentityProfile = { id: 'legacy', name: 'Legacy', userName: 'Legacy Author', userEmail: 'legacy@example.com' };
// Offering also asks whether the identity's account is still connected; an
// instance that has not been read answers null, which keeps it offered.
const unreadAccounts = () => null;
// The binding is unread until it answers, so the author alone decides.
const unreadBinding = undefined;
const profiles = [work, signed, plain];

// The clone screen no longer chooses an author on its own: it proposes one
// identity, which carries the author with it, and `proposeIdentityForHost`
// owns that rule and its tests.
describe('Git view authors', () => {
  test('offers every author for unrelated HTTPS, SSH, and absent remotes', () => {
    expect(offeredAuthors(profiles, globalIdentity, unreadAccounts)).toEqual([globalIdentity, ...profiles]);
  });

  test('retains ID deduplication, ordering, and stored signing data', () => {
    expect(offeredAuthors([signed, work, signed], globalIdentity, unreadAccounts)).toEqual([globalIdentity, signed, work]);
    expect(offeredAuthors([signed], null, unreadAccounts)[0]).toBe(signed);
    // An identity from an earlier release pushes with the machine's own Git, and is offered.
    expect(offeredAuthors([incomplete, work], null, unreadAccounts)).toEqual([incomplete, work]);
  });

  test('prefers a matching stored author over a matching global author and preserves signing', () => {
    expect(activeAuthor(
      profiles,
      { ...globalIdentity, userName: signed.userName, userEmail: signed.userEmail },
      { userName: signed.userName, userEmail: signed.userEmail },
      unreadBinding,
    )).toBe(signed);
  });

  test('uses the matching global author when no stored author matches', () => {
    expect(activeAuthor(profiles, globalIdentity, { userName: globalIdentity.userName, userEmail: globalIdentity.userEmail }, unreadBinding))
      .toBe(globalIdentity);
  });

  test('derives a local author from name and email without transport fields', () => {
    expect(activeAuthor(profiles, globalIdentity, { userName: 'Local Author', userEmail: 'local@example.com' }, unreadBinding)).toEqual({
      id: 'local-config', name: 'Local Author', userName: 'Local Author', userEmail: 'local@example.com', color: 'info', icon: 'user',
    });
  });

  test('preserves the global fallback when current author data is absent or incomplete', () => {
    for (const currentIdentity of [null, { userName: 'Incomplete', userEmail: null }]) {
      expect(activeAuthor(profiles, globalIdentity, currentIdentity, unreadBinding)).toBe(globalIdentity);
    }
    expect(activeAuthor([], null, null, unreadBinding)).toBeNull();
  });
});
