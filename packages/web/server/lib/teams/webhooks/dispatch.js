import { appendActivityEvent } from '../activity-log.js';
import { getEventStream } from '../../event-stream/index.js';

export async function dispatchWebhookEvent(workspaceId, eventName, payload, deliveryId) {
  const repoFullName = payload.repository?.full_name || '';
  const actorLogin = payload.sender?.login || '';
  
  let kind = null;
  let summaryPayload = {};

  if (eventName === 'pull_request') {
    kind = `pr.${payload.action}`;
    summaryPayload = {
      action: payload.action,
      pr_number: payload.pull_request?.number,
      title: payload.pull_request?.title,
    };
  } else if (eventName === 'pull_request_review') {
    kind = `review.${payload.action}`;
    summaryPayload = {
      action: payload.action,
      pr_number: payload.pull_request?.number,
      state: payload.review?.state,
    };
  } else if (eventName === 'pull_request_review_comment') {
    kind = `review_comment.${payload.action}`;
    summaryPayload = {
      action: payload.action,
      pr_number: payload.pull_request?.number,
    };
  } else if (eventName === 'check_run') {
    kind = `check_run.${payload.action}`;
    summaryPayload = {
      action: payload.action,
      name: payload.check_run?.name,
      conclusion: payload.check_run?.conclusion,
    };
  } else if (eventName === 'push') {
    kind = 'push';
    summaryPayload = {
      ref: payload.ref,
      commits_count: payload.commits?.length || 0,
    };
  }

  // If it's a recognized event kind, append it to the activity log
  if (kind) {
    const eventId = await appendActivityEvent({
      workspaceId,
      kind,
      actorLogin,
      repoFullName,
      payloadJson: JSON.stringify(summaryPayload),
      happenedAt: Date.now(),
    });

    // Broadcast to SSE channel so active clients can update
    const eventStream = getEventStream();
    if (eventStream) {
      eventStream.broadcast('teams.activity', {
        id: eventId,
        workspaceId,
        kind,
        actorLogin,
        repoFullName,
        payload: summaryPayload,
        happenedAt: Date.now()
      });
    }
  }
}
