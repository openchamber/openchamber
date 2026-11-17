export const ISSUE_KINDS = new Set([
  'issue-comment', 'issue-comment-update', 'issue-comment-delete', 'issue-state', 'issue-labels', 'issue-update', 'issue-assignees', 'issue-lock', 'issue-subscription',
  'change-request-comment-update', 'change-request-comment-delete', 'change-request-lock', 'change-request-subscription',
]);

export const DISCUSSION_KINDS = new Set([
  'discussion-comment', 'discussion-comment-update', 'discussion-comment-delete',
  'discussion-state', 'discussion-answer', 'discussion-labels', 'discussion-update',
]);

export const CONVERSATION_COMMENT_KINDS = new Set([
  'change-request-comment-update', 'change-request-comment-delete', 'issue-comment-update', 'issue-comment-delete',
]);

export const ownKind = (operation) => ISSUE_KINDS.has(operation) || DISCUSSION_KINDS.has(operation);
export const recordKind = (operation) => (ownKind(operation) ? operation : `change-request-${operation}`);
export const operationOf = (kind) => (ownKind(kind) ? kind : kind.replace(/^change-request-/, ''));
export const DISCUSSION_CLOSE_REASONS = Object.freeze({ resolved: 'RESOLVED', outdated: 'OUTDATED', duplicate: 'DUPLICATE' });
