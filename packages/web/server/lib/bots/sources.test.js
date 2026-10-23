import { expect, it } from 'vitest';
import { createBotSources } from './sources.js';

it('preserves arbitrary JQL exactly, admits multiple projects and deduplicates paged issues', async () => {
  const jql = 'assignee = currentUser() ORDER BY updated DESC';
  const calls = [];
  const sources = createBotSources({ resolveJiraContext: async () => ({ identityId: 'selected', identityRevision: 4, site: 'https://team.atlassian.net' }),
    discover: async () => [], services: { read: async (request) => {
      calls.push(request);
      return request.input.nextPageToken ? { issues: [{ key: 'ONE-7', summary: 'Repeated', description: '' }, { key: 'TWO-8', summary: 'Other project', description: 'Evidence' }], nextPageToken: null }
        : { issues: [{ key: 'ONE-7', summary: 'First', description: '' }], nextPageToken: 'page-2' };
    } },
  });
  const result = await sources.jira({ project: { id: 'p' }, bot: { id: 'b' }, jql, maxItems: 2 });
  expect(result.map((candidate) => candidate.source.id)).toEqual(['ONE-7', 'TWO-8']);
  expect(result[1].source.url).toBe('https://team.atlassian.net/browse/TWO-8');
  expect(calls).toEqual([
    { identityId: 'selected', identityRevision: 4, operation: 'jira.search', target: {}, input: { jql, maxResults: 2 } },
    { identityId: 'selected', identityRevision: 4, operation: 'jira.search', target: {}, input: { jql, maxResults: 1, nextPageToken: 'page-2' } },
  ]);
});

it('keeps failures and repeated cursors distinct from authoritative empty sources', async () => {
  let fail = false;
  const sources = createBotSources({ resolveJiraContext: async () => ({ identityId: 'selected', identityRevision: 4, site: 'https://team.atlassian.net' }), discover: async () => [],
    services: { read: async () => { if (fail) throw new Error('authorization required'); return { issues: [], nextPageToken: null }; } },
  });
  const request = { project: {}, bot: {}, jql: 'labels = security', maxItems: 200 };
  expect(await sources.jira(request)).toEqual([]);
  fail = true;
  await expect(sources.jira(request)).rejects.toThrow('authorization required');
  await expect(sources.jira({ ...request, maxItems: 0 })).rejects.toThrow();
});
