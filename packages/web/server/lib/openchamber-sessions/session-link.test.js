import { describe, expect, test } from 'bun:test';
import { mergeMetadataPatch } from './session-metadata-store.js';
import { buildLinkEntry, buildLinkPatch, createSessionLinker } from './session-link.js';
import { matchLinearUrl } from '../linear/tracker.js';

const matchTrackerUrl = (url) => {
  const identifier = matchLinearUrl(url);
  return identifier ? { provider: 'linear', identifier } : null;
};
// A registry with Linear's own `matchUrl` and a tracker that fails to load.
const trackers = {
  list: () => ['linear', 'broken'],
  implementation: async (id) => {
    if (id === 'broken') throw new Error('load failed');
    return { matchUrl: matchLinearUrl };
  },
};

class TestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const createLinker = (metadata = {}) => {
  const store = { metadata, writes: 0 };
  const linker = createSessionLinker({
    trackers,
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

  test('a registered tracker\'s item address becomes a tracker entry under the same id as before', () => {
    expect(buildLinkEntry({ url: 'https://linear.app/acme/issue/eng-12/search', title: 'Search', kind: 'issue' }, 1, { matchTrackerUrl }).entry).toEqual({
      // Linear keeps the kind older bundled UIs know, with the provider beside it.
      id: 'linear:ENG-12', kind: 'linear', provider: 'linear', identifier: 'ENG-12', title: 'Search', url: 'https://linear.app/acme/issue/eng-12/search', linkedAt: 1,
    });
    // Any other tracker is a `tracker` entry.
    const matchJira = () => ({ provider: 'jira', identifier: 'proj-4' });
    expect(buildLinkEntry({ url: 'https://acme.atlassian.net/browse/PROJ-4', title: 'Bug', kind: 'issue' }, 1, { matchTrackerUrl: matchJira }).entry)
      .toMatchObject({ id: 'jira:PROJ-4', kind: 'tracker', provider: 'jira', identifier: 'PROJ-4' });
    // Without a tracker that claims it, the address is an external link.
    expect(buildLinkEntry({ url: 'https://linear.app/acme/issue/eng-12/search', title: 'Search', kind: 'issue' }, 1).entry.kind).toBe('external');
  });

  test('any other service is stored as it was described', () => {
    expect(buildLinkEntry({ url: 'https://gitlab.com/acme/app/-/merge_requests/42#note', title: 'Fix login', kind: 'change', identifier: '!42' }, 1).entry).toEqual({
      id: 'link:https://gitlab.com/acme/app/-/merge_requests/42', kind: 'external', thread: 'change', identifier: '!42',
      title: 'Fix login', url: 'https://gitlab.com/acme/app/-/merge_requests/42', linkedAt: 1,
    });
    expect(buildLinkEntry({ url: 'https://www.jira.example/browse/OPS-7', title: 'Outage', kind: 'issue' }, 1).entry.identifier).toBe('jira.example');
  });

  test('a GitHub discussion is an external link under the id and number the UI gives one it links', () => {
    expect(buildLinkEntry({ url: 'https://github.com/acme/app/discussions/5#discussioncomment-9', title: 'Idea', kind: 'issue' }, 1).entry).toEqual({
      id: 'link:https://github.com/acme/app/discussions/5', kind: 'external', thread: 'issue', identifier: '#5',
      title: 'Idea', url: 'https://github.com/acme/app/discussions/5', linkedAt: 1,
    });
    // Its address decides that it is no change, whatever kind the model gave.
    expect(buildLinkEntry({ url: 'https://github.com/acme/app/discussions/5', title: 'Idea', kind: 'change' }, 1).entry.thread).toBe('issue');
  });

  test('a GitLab thread gets one id however its address was written', () => {
    const ids = [
      'https://git.example.cn/team/sub/app/-/merge_requests/600',
      'https://git.example.cn/team/sub/app/-/merge_requests/600/',
      'https://git.example.cn/team/sub/app/-/merge_requests/600/diffs?commit_id=abc#note_1',
    ].map((url) => buildLinkEntry({ url, title: 'MR', kind: 'change', identifier: '!600' }, 1).entry.id);
    expect(new Set(ids)).toEqual(new Set(['link:https://git.example.cn/team/sub/app/-/merge_requests/600']));
    expect(buildLinkEntry({ url: 'https://git.example.cn/team/app/-/merge_requests/600/diffs', title: 'MR', kind: 'change' }, 1).entry.url)
      .toBe('https://git.example.cn/team/app/-/merge_requests/600/diffs');
  });

  test('refuses what it cannot store', () => {
    expect(buildLinkEntry({ url: 'https://gitlab.com/x', title: '', kind: 'change' }, 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry({ url: 'https://gitlab.com/x', title: 'T', kind: 'pull' }, 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry({ url: 'file:///etc/passwd', title: 'T', kind: 'issue' }, 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry(undefined, 1).error).toEqual(expect.any(String));
    // A non-object link is refused, never parsed here: the agent tool revives
    // the one stringified shape the transport produces (issue #4591), and this
    // stays the clear rejection for everything else.
    expect(buildLinkEntry('{"url":"https://github.com/acme/app/issues/9","title":"T","kind":"issue"}', 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry(['https://github.com/acme/app/issues/9'], 1).error).toEqual(expect.any(String));
    expect(buildLinkEntry(null, 1).error).toEqual(expect.any(String));
  });
});

describe('session.link', () => {
  const pull = { url: 'https://github.com/acme/app/pull/7', title: 'Add search', kind: 'change' };

  test('links a tracker item through the registry, and a tracker that fails to load refuses nothing', async () => {
    const { linker, store } = createLinker();
    const result = await linker.link({ sessionId: 's1', link: { url: 'https://linear.app/acme/issue/ENG-3', title: 'T', kind: 'issue' } });
    expect(result.linked).toMatchObject({ id: 'linear:ENG-3', kind: 'linear', provider: 'linear' });
    expect(store.metadata.openchamber.linked_issues).toHaveLength(1);
  });

  test('re-linking an item stored as a legacy Linear entry refreshes it in place and keeps its kind', () => {
    const legacy = { id: 'linear:ENG-1', identifier: 'ENG-1', title: 'Spec', url: 'https://linear.app/x/issue/ENG-1', kind: 'linear', linkedAt: 1 };
    const same = buildLinkEntry({ url: 'https://linear.app/x/issue/ENG-1', title: 'Spec', kind: 'issue' }, 9, { matchTrackerUrl }).entry;
    expect(buildLinkPatch({ openchamber: { linked_issues: [legacy] } }, same)).toBeNull();
    // A renamed issue refreshes the snapshot; an older bundled UI still sees a `linear` entry.
    const renamed = buildLinkEntry({ url: 'https://linear.app/x/issue/ENG-1', title: 'Spec v2', kind: 'issue' }, 9, { matchTrackerUrl }).entry;
    expect(buildLinkPatch({ openchamber: { linked_issues: [legacy] } }, renamed).openchamber.linked_issues).toEqual([
      { ...legacy, title: 'Spec v2', kind: 'linear', provider: 'linear' },
    ]);
  });

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

  test('linking a merge request again under another title and address refreshes the one entry', async () => {
    const { linker, store } = createLinker();
    await linker.link({ sessionId: 's1', link: { url: 'https://gitlab.com/a/b/-/merge_requests/600', title: 'MR !600', kind: 'change', identifier: '!600' } });
    await linker.link({ sessionId: 's1', link: { url: 'https://gitlab.com/a/b/-/merge_requests/600/diffs', title: 'MR !600 review', kind: 'change', identifier: '!600' } });

    expect(store.metadata.openchamber.linked_issues.map((entry) => entry.title)).toEqual(['MR !600 review']);
  });

  test('a bad call writes nothing', async () => {
    const { linker, store } = createLinker();
    await expect(linker.link({ sessionId: 's1', link: { url: 'nope', title: 'T', kind: 'issue' } })).rejects.toMatchObject({ status: 400 });
    await expect(linker.link({ sessionId: null, link: pull })).rejects.toMatchObject({ status: 400 });
    expect(store.writes).toBe(0);
  });
});
