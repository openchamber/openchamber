import { z } from 'zod';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const number = z.number().int().positive();
const text = z.string().min(1);
const results = {
  'git.push': z.object({ headSha: sha, sourceHeadSha: sha, commitMap: z.array(z.object({ sourceSha: sha, publishedSha: sha })).optional() }),
  'pr.open': z.object({ number, headSha: sha, head: text, base: text }),
  'pr.comment': z.object({ number, headSha: sha, commentId: number }),
  'pr.auto-merge': z.object({ number, headSha: sha, status: z.enum(['pending', 'enqueued', 'merged']) }),
  'pr.disable-auto-merge': z.object({ number, headSha: sha, merged: z.boolean() }),
  'pr.dequeue': z.object({ number, headSha: sha, merged: z.boolean() }),
  'jira.comment': z.object({ commentId: text, issueKey: text }),
  'jira.question': z.object({ commentId: text, issueKey: text }),
  'jira.transition': z.object({ issueKey: text, statusId: text }),
  'discord.send': z.object({ messageId: text }),
  'discord.question': z.object({ messageId: text }),
};

/** Translate actual provider receipts into the compact item journal contract. */
export const botServiceReceipt = (prepared, raw) => {
  const result = results[prepared.operation].parse(raw);
  switch (prepared.operation) {
    case 'git.push': return { id: result.headSha, sha: result.headSha };
    case 'pr.open': return { id: String(result.number), sha: result.headSha, url: `https://github.com/${prepared.target.owner}/${prepared.target.repo}/pull/${result.number}` };
    case 'pr.comment': return { id: String(result.commentId), sha: result.headSha };
    case 'pr.auto-merge': return { id: String(result.number), sha: result.headSha };
    case 'pr.disable-auto-merge':
    case 'pr.dequeue': return { id: String(result.number), sha: result.headSha };
    case 'jira.comment':
    case 'jira.question': return { id: result.commentId };
    case 'jira.transition': return { id: `${result.issueKey}:${result.statusId}` };
    case 'discord.send':
    case 'discord.question': return { id: result.messageId };
    default: throw new Error('Unsupported bot provider receipt');
  }
};
