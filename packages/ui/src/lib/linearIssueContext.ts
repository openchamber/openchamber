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
  // Only the first comments page reaches the agent; say so when more exist
  // on Linear, so the newest discussion is never mistaken for all of it.
  const truncationNote = args.issue.commentsMore === true
    ? 'Note: only the first 50 comments are included; further comments exist on Linear.\n'
    : '';
  return `Linear issue context (JSON)\n${truncationNote}${JSON.stringify(payload, null, 2)}`;
}
