import { describe, expect, test } from 'bun:test';
import { mergeMetadataPatch } from './session-metadata-store.js';
import { buildLinkEntry, buildLinkPatch, createSessionLinker } from './session-link.js';

class TestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const createLinker = (metadata = {}) => {
  const store = { metadata, writes: 0 };
  const linker = createSessionLinker({
    updateMetadata: async (_sessionId, decide) => {
      const patch = decide(store.metadata);
      if (!patch) return { metadata: store.metadata, changed: false };
      store.metadata = mergeMetadataPatch(store.metadata, patch);
      store.writes += 1;
      return { metadata: store.metadata, changed: true };
    },
    createError: (message, status) => new TestError(message, status),
    now: () => 42,
  });
  return { linker, store };
};

describe('buildLinkEntry', () => {
  test('a GitHub address becomes the GitHub entry, its path deciding pull or issue', () => {
    expect(buildLinkEntry({ url: 'https://github.com/acme/app/pull/7/files', title: 'Add search', kind: 'issue' }, 1).entry).toEqual({
      id: 'acme/app#7', number: 7, title: 'Add search', url: 'https://github.com/acme/app/pull/7/files', kind: 'pull', linkedAt: 1,
    });
    expect(buildLinkEntry({ url: 'https://github.com/acme/app/issues/12', title: 'Slow', kind: 'change' }, 1).entry.kind).toBe('issue');
  });

  test('a Linear issue address becomes the Linear entry', () => {
    expect(buildLinkEntry({ url: 'https://linear.app/acme/issue/eng-12/search', title: 'Search', kind: 'issue' }, 1).entry).toEqual({
      id: 'linear:ENG-12', identifier: 'ENG-12', title: 'Search', url: 'https://linear.app/acme/issue/eng-12/search', kind: 'linear', linkedAt: 1,
    });
  });

  test('any other service is stored as it was described', () => {
    expect(buildLinkEntry({ url: 'https://gitlab.com/acme/app/-/merge_requests/42#note', title: 'Fix login', kind: 'change', identifier: '!42' }, 1).entry).toEqual({
      id: 'link:https://gitlab.com/acme/app/-/merge_requests/42', kind: 'external', thread: 'change', identifier: '!42',
      title: 'Fix login', url: 'https://gitlab.com/acme/app/-/merge_requests/42', linkedAt: 1,
    });
    expect(buildLinkEntry({ url: 'https://www.jira.example/browse/OPS-7', title: 'Outage', kind: 'issue' }, 1).entry.identifier).toBe('jira.example');
  });

  test('refuses what it cannot store', () => {
    expect(buildLinkEntry({ url: 'https://gitlab.com/x', title: '', kind: 'change' }, 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry({ url: 'https://gitlab.com/x', title: 'T', kind: 'pull' }, 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry({ url: 'file:///etc/passwd', title: 'T', kind: 'issue' }, 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry(undefined, 1).error).toEqual(expect.any(String));
  });
});

describe('session.link', () => {
  const pull = { url: 'https://github.com/acme/app/pull/7', title: 'Add search', kind: 'change' };

  test('appends to the links already there and keeps other metadata', async () => {
    const existing = { id: 'linear:ENG-1', identifier: 'ENG-1', title: 'Spec', url: 'https://linear.app/x', kind: 'linear', linkedAt: 1 };
    const { linker, store } = createLinker({ openchamber: { linked_issues: [existing], goal: { text: 'g' } } });
    const result = await linker.link({ sessionId: 's1', directory: '/repo', link: pull });

    expect(result.changed).toBe(true);
    expect(store.metadata.openchamber.goal).toEqual({ text: 'g' });
    expect(store.metadata.openchamber.linked_issues.map((entry) => entry.id)).toEqual(['linear:ENG-1', 'acme/app#7']);
  });

  test('linking the same thing again writes nothing', async () => {
    const { linker, store } = createLinker();
    await linker.link({ sessionId: 's1', link: pull });
    const again = await linker.link({ sessionId: 's1', link: pull });

    expect(again.changed).toBe(false);
    expect(store.writes).toBe(1);
  });

  test('a new title refreshes the entry in place, keeping its link time and what a picker recorded', () => {
    const entry = { id: 'acme/app#7', number: 7, title: 'Old', url: 'u', kind: 'pull', author: 'dev', linkedAt: 5 };
    const patch = buildLinkPatch({ openchamber: { linked_issues: [entry] } }, { id: 'acme/app#7', number: 7, title: 'New', url: 'u', kind: 'pull', linkedAt: 99 });
    expect(patch.openchamber.linked_issues).toEqual([{ ...entry, title: 'New', linkedAt: 5 }]);
  });

  test('a bad call writes nothing', async () => {
    const { linker, store } = createLinker();
    await expect(linker.link({ sessionId: 's1', link: { url: 'nope', title: 'T', kind: 'issue' } })).rejects.toMatchObject({ status: 400 });
    await expect(linker.link({ sessionId: null, link: pull })).rejects.toMatchObject({ status: 400 });
    expect(store.writes).toBe(0);
  });
});
