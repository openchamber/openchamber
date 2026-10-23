import { z } from 'zod';
import { BotServiceError, providerResult, text, jiraTarget } from './contracts.js';

const issue = z.object({ id: text, key: text, fields: z.object({
  project: z.object({ key: text }), status: z.object({ id: text, name: text }),
  summary: z.string(), description: z.unknown().optional(),
}) });
const comment = z.object({ id: text, author: z.object({ accountId: text, accountType: text.optional() }),
  body: z.unknown(), created: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  updated: text });
const transition = z.object({ id: text, name: text, to: z.object({ id: text, name: text }) });
const plainText = (value) => {
  if (value?.type === 'text' && z.string().safeParse(value.text).success) return value.text;
  if (!Array.isArray(value?.content)) return '';
  return value.content.map(plainText).join(value.type === 'doc' ? '\n' : '').slice(0, 60_000);
};
const adf = (body) => ({ version: 1, type: 'doc', content: body.split('\n').map((line) => ({
  type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
})) });

export function createJiraAdapter(credential, target, { beforeQuestionWrite } = {}) {
  const path = `/rest/api/3/issue/${encodeURIComponent(target.issueKey)}`;
  const readIssue = async () => {
    const result = providerResult(issue, await credential.request({ path: `${path}?fields=project,status,summary,description` }));
    if (result.key !== target.issueKey || result.fields.project.key !== target.projectKey) {
      throw new BotServiceError('BOT_SERVICE_TARGET_CHANGED', 'The Jira issue no longer belongs to the selected project.');
    }
    return { id: result.id, key: result.key, summary: result.fields.summary,
      status: result.fields.status, description: plainText(result.fields.description) };
  };
  const readTransitions = async () => {
    return providerResult(z.object({ transitions: z.array(transition).max(200) }),
      await credential.request({ path: `${path}/transitions` })).transitions;
  };
  return {
    async perform(operation, input) {
      const current = await readIssue();
      if (operation === 'jira.comment' || operation === 'jira.question') {
        const document = adf(input.body);
        if (operation === 'jira.question') {
          if (!(beforeQuestionWrite instanceof Function)) throw new BotServiceError('BOT_QUESTION_AUTHORITY_REQUIRED', 'Question mentions require service authorization.');
          document.content.unshift({ type: 'paragraph', content: input.recipients.map((person) => ({ type: 'mention', attrs: { id: person.serviceId } })) });
          await beforeQuestionWrite();
        }
        const result = providerResult(z.object({ id: text }), await credential.request({
          path: `${path}/comment`, method: 'POST', body: { body: document },
        }), true);
        return { commentId: result.id, issueKey: target.issueKey };
      }
      const available = await readTransitions();
      const selected = available.find((entry) => entry.id === input.transitionId);
      if (!selected || selected.to.id !== input.expectedStatusId) {
        throw new BotServiceError('BOT_JIRA_TRANSITION_UNAVAILABLE', 'Select a currently available Jira transition.');
      }
      await credential.request({ path: `${path}/transitions`, method: 'POST', body: { transition: { id: selected.id } } });
      return { issueKey: target.issueKey, previousStatusId: current.status.id, statusId: selected.to.id };
    },
    async reconcile(operation, input) {
      if (operation === 'jira.comment' || operation === 'jira.question') return { state: 'outcome-unknown' };
      const current = await readIssue();
      return current.status.id === input.expectedStatusId
        ? { state: 'succeeded', result: { issueKey: target.issueKey, statusId: current.status.id } }
        : { state: 'outcome-unknown' };
    },
    async read(operation, input) {
      if (operation === 'jira.issue') return readIssue();
      if (operation === 'jira.transitions') { await readIssue(); return readTransitions(); }
      if (operation !== 'jira.comments') throw new BotServiceError('BOT_SERVICE_UNSUPPORTED', 'This Jira read is unsupported.', 'failed', 400);
      await readIssue();
      const startAt = input.startAt ?? 0;
      if (!Number.isSafeInteger(startAt) || startAt < 0) throw new BotServiceError('BOT_SERVICE_INVALID_INPUT', 'The Jira cursor is invalid.', 'failed', 400);
      const page = providerResult(z.object({ startAt: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
        comments: z.array(comment).max(100) }), await credential.request({
        path: `${path}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
      }));
      if (page.startAt !== startAt || page.comments.length === 0 && startAt < page.total) {
        throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The Jira comment page is incomplete.');
      }
      return { comments: page.comments.map((entry) => ({ id: entry.id, authorId: entry.author.accountId,
        human: entry.author.accountType === 'atlassian' && entry.author.accountId !== credential.authority.providerAccountId,
        body: plainText(entry.body), createdAt: entry.created,
      })), total: page.total, nextStartAt: startAt + page.comments.length < page.total ? startAt + page.comments.length : null };
    },
  };
}

export async function searchJiraIssues(credential, input) {
  const query = z.object({ jql: z.string().min(1).max(4_000), nextPageToken: text.optional(),
    maxResults: z.number().int().min(1).max(100).default(50) }).strict();
  const parsed = query.safeParse(input);
  if (!parsed.success) {
    throw new BotServiceError('BOT_SERVICE_INVALID_INPUT', 'The Jira search input is invalid.', 'failed', 400);
  }
  const params = new URLSearchParams({ jql: parsed.data.jql,
    maxResults: String(parsed.data.maxResults), fields: 'project,status,summary,description' });
  if (parsed.data.nextPageToken) params.set('nextPageToken', parsed.data.nextPageToken);
  const page = providerResult(z.object({ issues: z.array(issue).max(100), isLast: z.boolean().optional(), nextPageToken: text.optional() }),
    await credential.request({ path: `/rest/api/3/search/jql?${params}` }));
  if (page.issues.some((entry) => !jiraTarget.safeParse({ projectKey: entry.fields.project.key, issueKey: entry.key }).success)
    || page.isLast === false && !page.nextPageToken) {
    throw new BotServiceError('BOT_SERVICE_RESPONSE_INVALID', 'The Jira search scope or cursor is invalid.');
  }
  return { issues: page.issues.map((entry) => ({ id: entry.id, key: entry.key, summary: entry.fields.summary,
    status: entry.fields.status, description: plainText(entry.fields.description) })), nextPageToken: page.isLast === true ? null : page.nextPageToken ?? null };
}
