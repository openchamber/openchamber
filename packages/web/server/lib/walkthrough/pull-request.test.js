import { describe, expect, it, vi } from 'vitest';
import { getPullRequestDiff, getPullRequestFileContents, supportsChangeRequestPatch } from './pull-request.js';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const added = true;
`;

const contextOf = (provider) => ({
  provider, instance: provider === 'github' ? 'github.com' : 'https://gitlab.com', accountId: 'account-1',
  repositoryId: 'repo-1', bindingRevision: 2, directory: '/repo', primaryRemote: 'origin',
});

describe('change request reads', () => {
  it('hands the validated context to the provider-neutral reader and keeps the empty-diff rule in the provider\'s words', async () => {
    const context = contextOf('gitlab');
    const readChangeRequestPatch = vi.fn(async () => ({ patch: PATCH, meta: { owner: 'o', repo: 'r', number: 3 } }));
    const sourceRepo = { owner: 'o', repo: 'r' };
    await expect(getPullRequestDiff('/repo', 3, context, { sourceRepo, readChangeRequestPatch }))
      .resolves.toEqual({ patch: PATCH, meta: { owner: 'o', repo: 'r', number: 3 } });
    expect(readChangeRequestPatch).toHaveBeenCalledWith({ context, number: 3, sourceRepo });

    const empty = vi.fn(async () => ({ patch: '   ', meta: { owner: 'o', repo: 'r', number: 4 } }));
    await expect(getPullRequestDiff('/repo', 4, context, { readChangeRequestPatch: empty }))
      .rejects.toMatchObject({ code: 'empty-diff', statusCode: 404, message: 'Merge request !4 has no diff' });
    await expect(getPullRequestDiff('/repo', 4, contextOf('github'), { readChangeRequestPatch: empty }))
      .rejects.toMatchObject({ code: 'empty-diff', message: 'Pull request #4 has no diff' });
    await expect(getPullRequestDiff('/repo', 4, context, { allowEmpty: true, readChangeRequestPatch: empty }))
      .resolves.toMatchObject({ patch: '   ' });
  });

  it('reads one file through the reader and fails plainly without one', async () => {
    const context = contextOf('github');
    const readChangeRequestFile = vi.fn(async () => ({ original: 'a', modified: 'b' }));
    await expect(getPullRequestFileContents('/repo', 3, context, { path: 'a.ts', status: 'M', readChangeRequestFile }))
      .resolves.toEqual({ original: 'a', modified: 'b' });
    expect(readChangeRequestFile).toHaveBeenCalledWith({ context, number: 3, sourceRepo: null, path: 'a.ts', previousPath: undefined, status: 'M' });
    await expect(getPullRequestDiff('/repo', 3, context)).rejects.toMatchObject({ statusCode: 501 });
    await expect(getPullRequestFileContents('/repo', 3, context, { path: 'a.ts' })).rejects.toMatchObject({ statusCode: 501 });
  });

  it('offers walkthroughs for the providers whose descriptor serves change request patches only', () => {
    expect(supportsChangeRequestPatch('github')).toBe(true);
    expect(supportsChangeRequestPatch('gitlab')).toBe(true);
    expect(supportsChangeRequestPatch('forgejo')).toBe(false);
    expect(supportsChangeRequestPatch(undefined)).toBe(false);
  });
});
