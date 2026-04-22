/**
 * Pure helper for the GitHub Inbox.
 */

export function computeIsStale(pr, now = Date.now()) {
  const threshold = 7 * 24 * 60 * 60 * 1000;
  const updated = new Date(pr.updated_at).getTime();
  return (now - updated) > threshold;
}

export function computeIsReadyToMerge(pr) {
  if (pr.draft || pr.state !== 'open' || pr.mergeable !== true) {
    return false;
  }
  // Wait, PR from search API doesn't have `mergeable` or `reviews`. 
  // We'll need to rely on `mergeable_state` or assume based on checks.
  return true;
}

export function formatInboxItemFromNotification(notification) {
  return {
    id: `notif-${notification.id}`,
    type: notification.subject.type, // 'PullRequest', 'Issue', 'CheckSuite', etc.
    title: notification.subject.title,
    repoFullName: notification.repository.full_name,
    url: notification.subject.url,
    updatedAt: notification.updated_at,
    reason: notification.reason, // 'assign', 'author', 'comment', 'mention', 'review_requested'
    notificationId: notification.id,
  };
}

export function formatInboxItemFromPR(pr, reason) {
  return {
    id: `pr-${pr.id}-${reason}`,
    type: 'PullRequest',
    title: pr.title,
    repoFullName: pr.repository_url.split('repos/')[1],
    url: pr.html_url,
    updatedAt: pr.updated_at,
    reason, // 'stale', 'ready_to_merge', 'ci_failing'
    number: pr.number,
  };
}
