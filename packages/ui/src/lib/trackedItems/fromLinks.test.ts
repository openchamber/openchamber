import { describe, expect, test } from 'bun:test';
import { linearIssue, trackedItemForReference } from './fromLinks';

const pull = {
  kind: 'pull' as const,
  number: 7,
  sourceRepo: { owner: 'acme', repo: 'app' },
};

describe('tracked items behind a repository reference', () => {
  test('names a GitHub pull or issue link without depending on a read context', () => {
    expect(trackedItemForReference(pull, null)).toEqual({
      provider: 'github', kind: 'pull', owner: 'acme', repo: 'app', number: 7,
    });
    expect(trackedItemForReference({ ...pull, kind: 'issue' }, { provider: 'gitlab', instance: 'https://gitlab.example.com' })).toEqual({
      provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number: 7,
    });
  });

  test('names a GitLab merge request with the instance its panel read through', () => {
    const context = { provider: 'gitlab' as const, instance: 'https://GitLab.Example.com' };
    expect(trackedItemForReference({ ...pull, provider: 'gitlab' }, context)).toEqual({
      provider: 'gitlab', instance: 'https://gitlab.example.com', kind: 'pull', owner: 'acme', repo: 'app', number: 7,
    });
    expect(trackedItemForReference({ ...pull, kind: 'issue', provider: 'gitlab' }, context)).toEqual({
      provider: 'gitlab', instance: 'https://gitlab.example.com', kind: 'issue', owner: 'acme', repo: 'app', number: 7,
    });
  });

  test('names nothing for a GitLab item whose instance is unknown', () => {
    expect(trackedItemForReference({ ...pull, provider: 'gitlab' }, null)).toBeNull();
    expect(trackedItemForReference({ ...pull, provider: 'gitlab' }, { provider: 'github', instance: 'github.com' })).toBeNull();
  });
});

describe('tracked Linear issues', () => {
  test('uses the identifier the server keys it by', () => {
    expect(linearIssue('eng-7')).toEqual({ provider: 'linear', identifier: 'ENG-7' });
  });
});
