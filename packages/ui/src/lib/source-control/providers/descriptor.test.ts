import { describe, expect, test } from 'bun:test';

import { sourceControlProviderIdSchema, sourceControlProviderListSchema, unknownProviderDescriptor } from './descriptor';
import { acmeDescriptor, changeHostDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from './descriptor.fixture';

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
      // Every server older than the field served change-request diffs.
      changeRequestTemplates: [], changeRequestPatch: true, reviewModel: 'verdict', revisions: false,
      submitRequirements: false, createByPush: false, branchHeads: true, discussions: false,
    });
  });

  test('reads discussions only where a server names them, and their links beside', () => {
    const [github] = sourceControlProviderListSchema.parse([githubLikeDescriptor()]);
    expect(github?.features.discussions).toBe(true);
    expect(github?.urls.discussion).toEqual(['/{owner}/{repo}/discussions/{number}']);
    // A server from before discussions names neither.
    const { discussion: _discussion, ...olderUrls } = githubLikeDescriptor().urls;
    const { discussions: _discussions, ...olderFeatures } = githubLikeDescriptor().features;
    const [older] = sourceControlProviderListSchema.parse([{ ...githubLikeDescriptor(), urls: olderUrls, features: olderFeatures }]);
    expect(older?.features.discussions).toBe(false);
    expect(older?.urls.discussion).toEqual([]);
  });

  test('reads a change host: its term, review model, revisions, submit, push-created changes and credential fields', () => {
    const [parsed] = sourceControlProviderListSchema.parse([changeHostDescriptor()]);
    expect(parsed?.terminology).toMatchObject({ changeRequest: 'change', abbreviation: 'CL', changeRequestPrefix: '#' });
    expect(parsed?.features).toMatchObject({
      reviewModel: 'votes', revisions: true, submitRequirements: true, createByPush: true, branchHeads: false,
    });
    expect(parsed?.settings.fields.map((field) => field.kind)).toEqual(['instance-url', 'username', 'http-password']);
  });

  test('reads a host that names none of the change-review features exactly as before', () => {
    const { reviewModel: _reviewModel, revisions: _revisions, submitRequirements: _submit, createByPush: _push, branchHeads: _heads, ...older } = acmeDescriptor().features;
    const [parsed] = sourceControlProviderListSchema.parse([{ ...acmeDescriptor(), features: older }]);
    expect(parsed?.features).toEqual(acmeDescriptor().features);
  });

  test('reads a change-review feature value this version does not know as its older meaning, keeping the provider', () => {
    const descriptor = acmeDescriptor();
    const [parsed] = sourceControlProviderListSchema.parse([{
      ...descriptor,
      features: { ...descriptor.features, reviewModel: 'scores', revisions: 'yes', submitRequirements: 1, createByPush: null, branchHeads: 'no' },
    }]);
    expect(parsed?.id).toBe('acme');
    expect(parsed?.features).toMatchObject({
      reviewModel: 'verdict', revisions: false, submitRequirements: false, createByPush: false, branchHeads: true,
    });
  });

  test('reads a host that does not serve change-request diffs as such', () => {
    const descriptor = acmeDescriptor();
    const [parsed] = sourceControlProviderListSchema.parse([{
      ...descriptor, features: { ...descriptor.features, changeRequestPatch: false },
    }]);
    expect(parsed?.features.changeRequestPatch).toBe(false);
  });

  test('refuses an icon path that is not path data', () => {
    const parsed = sourceControlProviderListSchema.parse([acmeDescriptor({ icon: { path: 'M0 0"/><script>' } })]);
    expect(parsed).toEqual([]);
  });

  test('keeps the extension that serves a provider, and drops a malformed marker without dropping the provider', () => {
    const extension = { guestId: 'acme-forge', name: 'Acme Forge', version: '1.2.0' };
    const [served, malformed, builtIn] = sourceControlProviderListSchema.parse([
      { ...acmeDescriptor({ id: 'ext-acme-forge', order: 1 }), extension },
      { ...acmeDescriptor({ id: 'ext-other', order: 2 }), extension: { guestId: '', name: 'Other' } },
      acmeDescriptor({ order: 3 }),
    ]);
    expect(served?.extension).toEqual(extension);
    expect(malformed?.id).toBe('ext-other');
    expect(malformed?.extension).toBeUndefined();
    expect(builtIn?.extension).toBeUndefined();
    expect(unknownProviderDescriptor('ext-gone').extension).toBeUndefined();
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
    const fallback = unknownProviderDescriptor('sourcehut');
    expect(unknownProviderDescriptor('sourcehut')).toBe(fallback);
    expect(fallback.label).toBe('sourcehut');
    expect(fallback.terminology).toMatchObject({ changeRequest: 'pullRequest', changeRequestPrefix: '#', issuePrefix: '#' });
    expect(fallback.icon.sprite).toBe('git-branch');
    expect(fallback.auth.methods).toEqual([]);
    expect(fallback.urls).toEqual({ changeRequest: [], issue: [], discussion: [], commit: [], user: [] });
    // `branchHeads` is how every host has behaved, not a feature turned on.
    const { branchHeads, reviewModel, ...features } = fallback.features;
    expect(Object.values(features).filter((value) => value === true)).toEqual([]);
    expect(branchHeads).toBe(true);
    expect(reviewModel).toBe('verdict');
  });
});
