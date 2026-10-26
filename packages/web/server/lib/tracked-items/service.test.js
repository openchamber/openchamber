import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTrackedItems, trackedItemKey } from './items.js';
import { createTrackedItemsService } from './service.js';

const githubPull = (number) => ({ provider: 'github', kind: 'pull', owner: 'acme', repo: 'app', number });
const githubIssue = (number) => ({ provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number });
const githubDiscussion = (number) => ({ provider: 'github', kind: 'discussion', owner: 'acme', repo: 'app', number });
const gitlabPull = (number) => ({ provider: 'gitlab', instance: 'https://gitlab.com', kind: 'pull', owner: 'group/sub', repo: 'app', number });
const linearIssue = (identifier) => ({ provider: 'linear', identifier });
const itemsOf = (...items) => parseTrackedItems(items, 100);

const pullSummary = (ref, state = 'open', extra = {}) => ({
  ...ref, state, draft: false, title: `PR ${ref.number}`, mergeable: null, mergeableState: null, checks: null, ...extra,
});

function setup({ readers = {}, persistence = null } = {}) {
  const open = new Set(['c1', 'c2']);
  const sent = [];
  const calls = { github: [], gitlab: [], linear: [] };
  const answers = {
    github: async (input) => ({
      status: 'ok',
      pulls: input.pulls.map((ref) => pullSummary(ref)),
      issues: input.issues.map((ref) => ({ ...ref, title: 'Issue', state: 'open' })),
      discussions: input.discussions.map((ref) => ({ ...ref, title: 'Discussion', state: 'open', answered: null })),
    }),
    gitlab: async (input) => ({ status: 'ok', pulls: input.pulls.map((ref) => pullSummary(ref)), issues: [] }),
    linear: async (input) => ({ status: 'ok', items: input.identifiers.map((identifier) => ({ identifier, title: identifier, state: { name: 'Todo', category: 'todo' } })) }),
    ...readers,
  };
  // The service sees two readers; the calls are kept per provider so each
  // test reads one provider's batches.
  const byProvider = ({ provider, ...input }) => {
    calls[provider].push(input);
    return answers[provider](input);
  };
  const service = createTrackedItemsService({
    readers: { sourceControl: byProvider, workItems: byProvider },
    send: (id, event) => { if (!open.has(id)) return false; sent.push({ id, event }); return true; },
    isConnectionOpen: (id) => open.has(id),
    persistence,
    log: { warn: () => {} },
  });
  return { service, sent, calls, open };
}

describe('tracked items', () => {
  it('follows a discussion only where its provider keeps them', () => {
    const items = parseTrackedItems([githubDiscussion(4), { ...gitlabPull(3), kind: 'discussion' }], 100);
    expect([...items.values()]).toEqual([{ ...githubDiscussion(4), instance: undefined }]);
  });
});

describe('tracked items service', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks each provider once per batch for a visible client and pushes only to the clients that show the item', async () => {
    const { service, sent, calls } = setup();
    service.setInterest('c1', itemsOf(githubPull(1), githubIssue(2), githubDiscussion(4), gitlabPull(3), linearIssue('ope-7')));
    service.setInterest('c2', itemsOf(githubPull(9)));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.github).toHaveLength(1);
    expect(calls.github[0]).toEqual({
      instance: 'github.com',
      accountId: null,
      pulls: [{ owner: 'acme', repo: 'app', number: 1 }, { owner: 'acme', repo: 'app', number: 9 }],
      issues: [{ owner: 'acme', repo: 'app', number: 2 }],
      discussions: [{ owner: 'acme', repo: 'app', number: 4 }],
    });
    expect(calls.gitlab[0]).toMatchObject({ instance: 'https://gitlab.com', pulls: [{ owner: 'group/sub', repo: 'app', number: 3 }] });
    expect(calls.linear[0]).toEqual({ identifiers: ['OPE-7'] });
    expect(calls.gitlab[0]).toMatchObject({ accountId: null });
    const keysFor = (id) => sent.filter((entry) => entry.id === id).flatMap((entry) => entry.event.properties.states.map((state) => state.key)).sort();
    expect(keysFor('c1')).toEqual([githubPull(1), githubIssue(2), githubDiscussion(4), gitlabPull(3), { provider: 'linear', kind: 'work-item', identifier: 'OPE-7' }].map(trackedItemKey).sort());
    expect(keysFor('c2')).toEqual([trackedItemKey(githubPull(9))]);
  });

  it('groups GitHub items per host, so one enterprise instance never shares a github.com slot', async () => {
    const { service, calls } = setup();
    service.setInterest('c1', itemsOf(githubPull(1), { ...githubPull(2), instance: 'github.acme.com' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.github).toHaveLength(2);
    expect(calls.github[0]).toEqual({ instance: 'github.com', accountId: null, pulls: [{ owner: 'acme', repo: 'app', number: 1 }], issues: [], discussions: [] });
    expect(calls.github[1]).toEqual({ instance: 'github.acme.com', accountId: null, pulls: [{ owner: 'acme', repo: 'app', number: 2 }], issues: [], discussions: [] });
  });

  it('stays quiet while nothing changed and while the client is hidden, and catches up when it returns', async () => {
    const { service, sent, calls } = setup();
    service.setInterest('c1', itemsOf(githubPull(1)));
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.github).toHaveLength(2);
    expect(sent).toHaveLength(0);

    service.setPresence('c1', false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.github).toHaveLength(2);

    service.setPresence('c1', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.github).toHaveLength(3);
  });

  it('keeps the last known state through a failed read and backs off before asking again', async () => {
    let fail = false;
    const { service, sent, calls } = setup({
      readers: { github: async (input) => (fail ? Promise.reject(new Error('down')) : { status: 'ok', pulls: input.pulls.map((ref) => pullSummary(ref)), issues: [] }) },
    });
    service.setInterest('c1', itemsOf(githubPull(1)));
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.github).toHaveLength(2);
    expect(sent).toHaveLength(0);
    // Backed off for 30 s past the failure, not asked at the next minute boundary early.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls.github).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.github).toHaveLength(3);
  });

  it('never asks about a merged pull request again and clears an item the provider no longer answers', async () => {
    let answerTwo = true;
    const { service, sent, calls } = setup({
      readers: {
        github: async (input) => ({
          status: 'ok',
          pulls: input.pulls.filter((ref) => ref.number !== 2 || answerTwo).map((ref) => pullSummary(ref, ref.number === 1 ? 'merged' : 'open')),
          issues: [],
        }),
      },
    });
    service.setInterest('c1', itemsOf(githubPull(1), githubPull(2)));
    await vi.advanceTimersByTimeAsync(0);
    answerTwo = false;
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.github[1].pulls.map((ref) => ref.number)).toEqual([2]);
    expect(sent[0].event.properties.states).toEqual([expect.objectContaining({ key: trackedItemKey(githubPull(2)), state: null })]);
  });

  it('starts from persisted state and refreshes open items after an agent turn settles', async () => {
    const saved = [{ key: trackedItemKey(githubPull(1)), item: githubPull(1), state: pullSummary({ owner: 'acme', repo: 'app', number: 1 }), fetchedAt: Date.now() - 1000 }];
    const persistence = { load: vi.fn(async () => saved), save: vi.fn(async () => {}) };
    const { service, calls } = setup({ persistence });
    await service.ready();
    const known = service.setInterest('c1', itemsOf(githubPull(1)));
    expect(known).toEqual([expect.objectContaining({ key: saved[0].key, state: saved[0].state })]);
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.github.length;

    service.noteTurnFinished();
    service.noteTurnFinished();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.github.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls.github.length).toBe(before + 1);
  });

  it('reads one provider\'s open items again at once after a change made through it', async () => {
    const { service, calls } = setup();
    service.setInterest('c1', itemsOf(githubPull(1), linearIssue('ope-7')));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.github).toHaveLength(1);
    expect(calls.linear).toHaveLength(1);

    service.refreshProvider('github');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.github).toHaveLength(2);
    expect(calls.linear).toHaveLength(1);
  });

  it('reads only the one item a user refreshed, whatever account follows it', async () => {
    const { service, calls } = setup();
    service.setInterest('c1', itemsOf(githubPull(1), githubPull(2)));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.github).toHaveLength(1);

    service.refreshItem('github', { owner: 'Acme', repo: 'App', number: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.github).toHaveLength(2);
    expect(calls.github[1]).toMatchObject({ pulls: [{ owner: 'acme', repo: 'app', number: 2 }] });
  });

  it('reads work items on a cadence set by their state category', async () => {
    let category = 'in-progress';
    const { service, calls } = setup({
      readers: { linear: async (input) => ({ status: 'ok', items: input.identifiers.map((identifier) => ({ identifier, title: identifier, state: { name: 'S', category } })) }) },
    });
    service.setInterest('c1', itemsOf(linearIssue('ope-7')));
    await vi.advanceTimersByTimeAsync(0);
    // Open: every two minutes.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls.linear).toHaveLength(2);
    category = 'done';
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls.linear).toHaveLength(3);
    // Settled (done or canceled): every five minutes.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(calls.linear).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.linear).toHaveLength(4);
  });

  it('follows a work item in the legacy Linear shape and in the neutral one under the same key', async () => {
    const { service, calls } = setup();
    const legacy = itemsOf(linearIssue('ope-7'));
    const neutral = itemsOf({ provider: 'linear', kind: 'work-item', identifier: 'OPE-7' });
    expect([...legacy.keys()]).toEqual(['linear|OPE-7']);
    expect([...neutral.keys()]).toEqual(['linear|OPE-7']);
    expect([...legacy.values()]).toEqual([{ provider: 'linear', kind: 'work-item', identifier: 'OPE-7' }]);
    service.setInterest('c1', legacy);
    service.setInterest('c2', neutral);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.linear).toEqual([{ identifiers: ['OPE-7'] }]);
  });

  it('reads one work item a user refreshed by its identifier', async () => {
    const { service, calls } = setup();
    service.setInterest('c1', itemsOf(linearIssue('ope-7'), linearIssue('ope-8'), githubPull(7)));
    await vi.advanceTimersByTimeAsync(0);
    service.refreshItem('linear', { identifier: 'ope-8' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.linear).toHaveLength(2);
    expect(calls.linear[1]).toEqual({ identifiers: ['OPE-8'] });
    expect(calls.github).toHaveLength(1);
  });

  it('refuses interest from a connection that is not open and forgets closed ones', async () => {
    const { service, sent, open } = setup();
    expect(() => service.setInterest('gone', itemsOf(githubPull(1)))).toThrow(expect.objectContaining({ code: 'unknown-connection' }));
    service.setInterest('c1', itemsOf(githubPull(1)));
    open.delete('c1');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);
  });
});

describe('tracked item parsing', () => {
  it('accepts GitLab subgroups and normalizes keys, and drops what names nothing', () => {
    const items = parseTrackedItems([
      gitlabPull(3),
      { ...gitlabPull(3), instance: 'https://GitLab.com/' },
      { provider: 'github', kind: 'pull', owner: 'a/b', repo: 'app', number: 1 },
      { provider: 'linear', identifier: 'not an id' },
      { provider: 'bitbucket', kind: 'pull', owner: 'a', repo: 'b', number: 1 },
      // A source-control id or a reserved id never names a tracker.
      { provider: 'github', kind: 'work-item', identifier: 'ENG-1' },
      { provider: 'guest', kind: 'work-item', identifier: 'ENG-1' },
      { provider: 'Bad Id', kind: 'work-item', identifier: 'ENG-1' },
    ], 10);
    expect([...items.keys()]).toEqual(['gitlab|https://gitlab.com|pull|group/sub/app#3']);
    // The same pull request read with a bound account is a separate item.
    const bound = parseTrackedItems([{ ...githubPull(1), accountId: 'github.com#7' }, githubPull(1)], 10);
    expect([...bound.keys()]).toEqual(['github|github.com|pull|acme/app#1@github.com#7', 'github|github.com|pull|acme/app#1']);
    // The same owner/repo on an enterprise host is a different item.
    const hosts = parseTrackedItems([githubPull(1), { ...githubPull(1), instance: 'github.acme.com' }], 10);
    expect([...hosts.keys()]).toEqual(['github|github.com|pull|acme/app#1', 'github|github.acme.com|pull|acme/app#1']);
    // A tracker this server does not register still parses: the reader decides.
    const trackers = parseTrackedItems([{ provider: 'jira', kind: 'work-item', identifier: 'ops-7' }], 10);
    expect([...trackers.entries()]).toEqual([['jira|OPS-7', { provider: 'jira', kind: 'work-item', identifier: 'OPS-7' }]]);
    expect(parseTrackedItems('nope', 10)).toBeNull();
    expect(parseTrackedItems([gitlabPull(1), gitlabPull(2)], 1)).toBeNull();
  });
});
