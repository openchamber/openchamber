import type { LinearIssue, LinearIssueComment } from '@/lib/api/types';

/** What an agent receives for an attached Linear issue: the issue and its comments as JSON. */
export function buildIssueContextText(args: {
  issue: LinearIssue;
  comments: LinearIssueComment[];
}): string {
  const payload = {
    issue: args.issue,
    comments: args.comments,
  };
  return `Linear issue context (JSON)\n${JSON.stringify(payload, null, 2)}`;
}
