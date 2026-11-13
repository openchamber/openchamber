import { describe, expect, test } from 'bun:test';
import { gitIdentityProfileSchema } from './git-identity';

const profile = (provider: string) => ({
  id: 'work',
  name: 'Work',
  userName: 'Octo',
  userEmail: 'octo@example.com',
  account: { provider, instance: 'https://forge.example.com', accountId: 'occred:v1:x:one:r1' },
  transport: 'account',
});

describe('git identity account provider', () => {
  test('reads any provider id the server serves, old and new alike', () => {
    for (const provider of ['github', 'gitlab', 'acme']) {
      expect(gitIdentityProfileSchema.parse(profile(provider))).toEqual(profile(provider));
    }
  });

  test('refuses a malformed provider id', () => {
    expect(gitIdentityProfileSchema.safeParse(profile('Bit Bucket')).success).toBe(false);
  });
});
