import { describe, expect, test } from 'bun:test';
import { createGitIdentityProvisioning } from './identity-provisioning.js';

const github = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1' };
const gitlab = { provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'occred:v1:gitlab:one:r1' };

const harness = (profiles = []) => {
  const state = [...profiles];
  let sequence = 0;
  return {
    profiles: state,
    provisioning: createGitIdentityProvisioning({
      store: {
        getProfiles: () => state.map((profile) => ({ ...profile })),
        createProfile: (profile) => { state.push({ ...profile }); return { ...profile }; },
        updateProfile: (id, updates) => {
          const index = state.findIndex((profile) => profile.id === id);
          state[index] = { ...state[index], ...updates, id };
          return { ...state[index] };
        },
      },
      now: () => 1_000,
      randomId: () => `r${(sequence += 1)}`,
    }),
  };
};

describe('ensureAccountIdentity', () => {
  test('makes an identity that names the account, its transport and its signature', () => {
    const { provisioning, profiles } = harness();
    const created = provisioning.ensureAccountIdentity({
      account: gitlab, user: { id: 42, login: 'ada', name: 'Ada L.', email: 'ada@example.com' },
    });
    expect(created).toMatchObject({
      name: 'ada', userName: 'Ada L.', userEmail: 'ada@example.com', account: gitlab, transport: 'account',
    });
    expect(profiles).toHaveLength(1);
  });

  test('signs GitHub with its own no-reply address when the account publishes none', () => {
    const { provisioning } = harness();
    const created = provisioning.ensureAccountIdentity({
      account: github, user: { id: 7, login: 'ada', name: 'Ada L.' },
    });
    expect(created?.userEmail).toBe('7+ada@users.noreply.github.com');
  });

  test('makes nothing when the account cannot supply a signature', () => {
    const { provisioning, profiles } = harness();
    // GitLab publishes no no-reply convention, so an account with no address
    // leaves the identity to the person rather than inventing one.
    expect(provisioning.ensureAccountIdentity({ account: gitlab, user: { id: 42, login: 'ada' } })).toBeNull();
    expect(provisioning.ensureAccountIdentity({ account: { provider: 'github' }, user: { id: 1, login: 'a', email: 'a@b.c' } })).toBeNull();
    expect(profiles).toHaveLength(0);
  });

  test('does not make a second identity for an account that already has one', () => {
    const { provisioning, profiles } = harness();
    const user = { id: 42, login: 'ada', name: 'Ada L.', email: 'ada@example.com' };
    const first = provisioning.ensureAccountIdentity({ account: gitlab, user });
    const again = provisioning.ensureAccountIdentity({ account: gitlab, user });
    expect(again).toEqual(first);
    expect(profiles).toHaveLength(1);
  });

  test('reuses the identity of a person who connects again after disconnecting', () => {
    const { provisioning, profiles } = harness();
    const user = { id: 7, login: 'ada', name: 'Ada', email: 'ada@example.com' };
    const first = provisioning.ensureAccountIdentity({ account: gitlab, user });
    expect(first.name).toBe('ada');

    // Disconnecting leaves the identity behind; connecting again mints a new
    // credential id, and the person expects their identity, not a second one.
    const renewed = { ...gitlab, accountId: 'occred:v1:gitlab:two:r1' };
    const again = provisioning.ensureAccountIdentity({ account: renewed, user });
    expect(again.id).toBe(first.id);
    expect(again.account).toEqual(renewed);
    expect(profiles).toHaveLength(1);
  });

  test('keeps names apart when two accounts share a login', () => {
    const { provisioning } = harness();
    const user = { id: 42, login: 'ada', name: 'Ada L.', email: 'ada@example.com' };
    provisioning.ensureAccountIdentity({ account: gitlab, user });
    const second = provisioning.ensureAccountIdentity({ account: github, user });
    expect(second?.name).toBe('ada (GitHub)');
  });

  test('falls back to the host when the provider name is taken too', () => {
    const { provisioning, profiles } = harness();
    const user = { id: 7, login: 'ada', name: 'Ada', email: 'ada@example.com' };
    const onInstance = (instance, accountId) =>
      provisioning.ensureAccountIdentity({ account: { provider: 'gitlab', instance, accountId }, user }).name;

    expect(onInstance('https://gitlab.com', 'occred:v1:gitlab:one:r1')).toBe('ada');
    expect(onInstance('https://git.example.test', 'occred:v1:gitlab:two:r1')).toBe('ada (GitLab)');
    // A third GitLab cannot use the provider name either, so the host that
    // tells them apart is what names it.
    expect(onInstance('https://git.other.test', 'occred:v1:gitlab:three:r1')).toBe('ada (git.other.test)');
    expect(profiles).toHaveLength(3);
  });
});

describe('repointAccountIdentities', () => {
  test('follows a renewed credential', () => {
    const { provisioning, profiles } = harness();
    const user = { id: 42, login: 'ada', name: 'Ada L.', email: 'ada@example.com' };
    provisioning.ensureAccountIdentity({ account: gitlab, user });
    const renewed = { ...gitlab, accountId: 'occred:v1:gitlab:two:r1' };

    const updated = provisioning.repointAccountIdentities({ from: gitlab, to: renewed });
    expect(updated).toHaveLength(1);
    expect(profiles[0].account).toEqual(renewed);
  });

  test('leaves alone what it does not name', () => {
    const { provisioning, profiles } = harness();
    const user = { id: 42, login: 'ada', name: 'Ada L.', email: 'ada@example.com' };
    provisioning.ensureAccountIdentity({ account: gitlab, user });
    expect(provisioning.repointAccountIdentities({ from: github, to: { ...github, accountId: 'other' } })).toEqual([]);
    // A different instance is a different account, however alike the ids look.
    expect(provisioning.repointAccountIdentities({
      from: { ...gitlab, instance: 'https://gitlab.example' },
      to: { ...gitlab, instance: 'https://gitlab.example', accountId: 'x' },
    })).toEqual([]);
    expect(provisioning.repointAccountIdentities({ from: gitlab, to: gitlab })).toEqual([]);
    expect(profiles[0].account).toEqual(gitlab);
  });
});
