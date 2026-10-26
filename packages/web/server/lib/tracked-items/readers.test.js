import { describe, expect, it, vi } from 'vitest';
import { createTrackedItemReaders } from './readers.js';

const trackersWith = (implementations) => ({
  implementation: vi.fn(async (id) => implementations[id] ?? null),
});

describe('tracked item readers', () => {
  it('reads change requests and issues through the provider-neutral reader', async () => {
    const readLiveSummaries = vi.fn(async () => ({ connected: true, summaries: [{ number: 3 }], issueSummaries: [{ number: 4 }] }));
    const readers = createTrackedItemReaders({ readLiveSummaries });
    await expect(readers.sourceControl({
      provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'acc', pulls: [{ owner: 'g', repo: 'r', number: 3 }], issues: [],
    })).resolves.toEqual({ status: 'ok', pulls: [{ number: 3 }], issues: [{ number: 4 }], discussions: [] });
    expect(readLiveSummaries).toHaveBeenCalledWith({
      provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'acc', refs: [{ owner: 'g', repo: 'r', number: 3 }], issueRefs: [], discussionRefs: [],
    });
  });

  it('says why a provider cannot answer: no account, or its own status', async () => {
    const answer = (result) => createTrackedItemReaders({ readLiveSummaries: async () => result })
      .sourceControl({ provider: 'github', instance: 'github.com', pulls: [], issues: [] });
    await expect(answer({ connected: false })).resolves.toEqual({ status: 'disconnected' });
    // GitHub's per-host rate limit and refused token come back as a status.
    await expect(answer({ connected: true, status: 'unavailable' })).resolves.toEqual({ status: 'unavailable' });
    await expect(answer({ connected: true, status: 'unavailable', retryAfterMs: 5000 })).resolves.toEqual({ status: 'unavailable', retryAfterMs: 5000 });
    await expect(answer({ connected: true, status: 'disconnected' })).resolves.toEqual({ status: 'disconnected' });
    await expect(createTrackedItemReaders({}).sourceControl({ provider: 'github', pulls: [], issues: [] }))
      .resolves.toEqual({ status: 'disconnected' });
  });

  it('reads work items through the tracker registry', async () => {
    const liveSummaries = vi.fn(async () => ({ connected: true, items: [{ identifier: 'OPE-1', title: 'T', state: { name: 'Todo', category: 'todo' } }] }));
    const trackers = trackersWith({ linear: { liveSummaries } });
    await expect(createTrackedItemReaders({ trackers }).workItems({ provider: 'linear', identifiers: ['OPE-1'] }))
      .resolves.toEqual({ status: 'ok', items: [{ identifier: 'OPE-1', title: 'T', state: { name: 'Todo', category: 'todo' } }] });
    expect(liveSummaries).toHaveBeenCalledWith(['OPE-1']);
    const disconnected = trackersWith({ linear: { liveSummaries: async () => ({ connected: false }) } });
    await expect(createTrackedItemReaders({ trackers: disconnected }).workItems({ provider: 'linear', identifiers: ['OPE-1'] }))
      .resolves.toEqual({ status: 'disconnected' });
  });

  it('answers disconnected for a tracker this server does not register', async () => {
    const trackers = trackersWith({});
    await expect(createTrackedItemReaders({ trackers }).workItems({ provider: 'jira', identifiers: ['OPS-1'] }))
      .resolves.toEqual({ status: 'disconnected' });
    expect(trackers.implementation).toHaveBeenCalledWith('jira');
  });
});
