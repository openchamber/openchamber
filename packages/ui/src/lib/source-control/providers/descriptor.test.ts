import { describe, expect, test } from 'bun:test';

import { sourceControlProviderIdSchema, sourceControlProviderListSchema, unknownProviderDescriptor } from './descriptor';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from './descriptor.fixture';

describe('source-control provider descriptors', () => {
  test('accepts syntactic provider ids and refuses reserved ones', () => {
    for (const id of ['github', 'gitlab', 'gitea', 'acme-forge', 'a']) {
      expect(sourceControlProviderIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ['linear', 'guest', 'link', 'external', 'repository', 'GitHub', '1forge', '-x', '', 'a'.repeat(33), 'a_b']) {
      expect(sourceControlProviderIdSchema.safeParse(id).success).toBe(false);
    }
  });

  test('orders a list and leaves out a malformed, reserved or repeated descriptor without failing the rest', () => {
    const parsed = sourceControlProviderListSchema.parse([
      acmeDescriptor(),
      gitlabLikeDescriptor(),
      { ...acmeDescriptor(), id: 'linear' },
      { id: 'broken' },
      { ...acmeDescriptor(), label: 'Second acme' },
      githubLikeDescriptor(),
    ]);
    expect(parsed.map((descriptor) => descriptor.id)).toEqual(['github', 'gitlab', 'acme']);
    expect(parsed[2]?.label).toBe('Acme Forge');
  });

  test('reads values a newer server may send as their closest known meaning', () => {
    const descriptor = acmeDescriptor();
    const [parsed] = sourceControlProviderListSchema.parse([{
      ...descriptor,
      terminology: { ...descriptor.terminology, changeRequest: 'changeset' },
      auth: { ...descriptor.auth, methods: ['pat', 'web-oauth'] },
      settings: { fields: [{ id: 'app', kind: 'app-installation', secret: false }] },
      features: { referenceSearch: true },
    }]);
    expect(parsed?.terminology.changeRequest).toBe('pullRequest');
    expect(parsed?.auth.methods).toEqual(['pat']);
    expect(parsed?.settings.fields[0]?.kind).toBe('unknown');
    expect(parsed?.features).toEqual({
      referenceSearch: true, referenceDetail: false, listStatuses: false, referencesAcross: false,
      startThread: false, authorCanReview: false, projectUploads: false, issueCloseReason: false,
      changeRequestTemplates: [],
    });
  });

  test('refuses an icon path that is not path data', () => {
    const parsed = sourceControlProviderListSchema.parse([acmeDescriptor({ icon: { path: 'M0 0"/><script>' } })]);
    expect(parsed).toEqual([]);
  });

  test('round-trips its own output, so a stored list reads back unchanged', () => {
    const list = sourceControlProviderListSchema.parse([acmeDescriptor(), gitlabLikeDescriptor()]);
    expect(sourceControlProviderListSchema.parse(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  test('falls back to a stable generic descriptor with every feature off', () => {
    const fallback = unknownProviderDescriptor('forgejo');
    expect(unknownProviderDescriptor('forgejo')).toBe(fallback);
    expect(fallback.label).toBe('forgejo');
    expect(fallback.terminology).toMatchObject({ changeRequest: 'pullRequest', changeRequestPrefix: '#', issuePrefix: '#' });
    expect(fallback.icon.sprite).toBe('git-branch');
    expect(fallback.auth.methods).toEqual([]);
    expect(fallback.urls).toEqual({ changeRequest: [], issue: [] });
    expect(Object.values(fallback.features).filter((value) => value === true)).toEqual([]);
  });
});
