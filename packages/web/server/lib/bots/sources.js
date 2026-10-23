import { z } from 'zod';
import { jiraOrigin } from './services/contracts.js';
import { sourceCandidateSchema } from './prompts.js';

const contextSchema = z.object({ identityId: z.string().min(1), identityRevision: z.number().int().positive(), site: z.string() }).strict();
const pageSchema = z.object({ issues: z.array(z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}-[1-9][0-9]*$/), summary: z.string().min(1), description: z.string() })), nextPageToken: z.string().nullable() });

/** JQL admission spends no model tokens. Discovery owns its read-only session. */
export const createBotSources = ({ services, resolveJiraContext, discover }) => {
  if (!(services?.read instanceof Function) || !(resolveJiraContext instanceof Function) || !(discover instanceof Function)) throw new TypeError('Bot sources require provider reads, exact Jira context and read-only discovery');
  return {
    async jira({ project, bot, jql, maxItems }) {
      z.number().int().positive().parse(maxItems);
      z.string().min(1).parse(jql);
      const context = contextSchema.parse(await resolveJiraContext({ project, bot }));
      const site = jiraOrigin(context.site);
      const candidates = new Map();
      const cursors = new Set();
      let nextPageToken;
      do {
        const input = { jql, maxResults: Math.min(100, maxItems - candidates.size) };
        if (nextPageToken) input.nextPageToken = nextPageToken;
        const page = pageSchema.parse(await services.read({ identityId: context.identityId, identityRevision: context.identityRevision,
          operation: 'jira.search', target: {},
          input,
        }));
        for (const issue of page.issues) {
          candidates.set(issue.key, sourceCandidateSchema.parse({ source: { kind: 'jira', id: issue.key, url: `${site}/browse/${encodeURIComponent(issue.key)}` }, title: issue.summary, description: issue.description,
            evidence: [{ source: issue.key, summary: issue.summary, url: `${site}/browse/${encodeURIComponent(issue.key)}` }] }));
          if (candidates.size === maxItems) break;
        }
        nextPageToken = page.nextPageToken;
        if (nextPageToken && cursors.has(nextPageToken)) throw new Error('Jira repeated a pagination cursor');
        if (nextPageToken) cursors.add(nextPageToken);
      } while (nextPageToken && candidates.size < maxItems);
      return [...candidates.values()];
    },
    async investigate(request) { return z.array(sourceCandidateSchema).parse(await discover(request)); },
  };
};
