export const ISSUE_KINDS: ReadonlySet<string> = new Set([
  'issue-comment', 'issue-comment-update', 'issue-comment-delete', 'issue-state', 'issue-labels', 'issue-update', 'issue-assignees',
  'change-request-comment-update', 'change-request-comment-delete',
]);

export const DISCUSSION_KINDS: ReadonlySet<string> = new Set([
  'discussion-comment', 'discussion-comment-update', 'discussion-comment-delete',
  'discussion-state', 'discussion-answer', 'discussion-labels', 'discussion-update',
]);

export const CONVERSATION_COMMENT_KINDS: ReadonlySet<string> = new Set([
  'change-request-comment-update', 'change-request-comment-delete', 'issue-comment-update', 'issue-comment-delete',
]);

export const ownKind = (operation: string) => ISSUE_KINDS.has(operation) || DISCUSSION_KINDS.has(operation);
export const recordKind = (operation: string) => (ownKind(operation) ? operation : `change-request-${operation}`);
export const operationOf = (kind: string) => (ownKind(kind) ? kind : kind.replace(/^change-request-/, ''));
export const DISCUSSION_CLOSE_REASONS: Readonly<Record<string, string>> = Object.freeze({ resolved: 'RESOLVED', outdated: 'OUTDATED', duplicate: 'DUPLICATE' });

export const REVIEW_DRAFT_OPERATIONS: ReadonlySet<string> = new Set(['review-comment', 'review-comment-update', 'review-comment-delete', 'review-discard']);

export const REVIEW_EVENTS = Object.freeze({
  approve: { event: 'APPROVE', state: 'APPROVED' },
  'request-changes': { event: 'REQUEST_CHANGES', state: 'CHANGES_REQUESTED' },
  comment: { event: 'COMMENT', state: 'COMMENTED' },
});
