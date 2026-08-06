import { getJiraConnection } from './auth.js';
import { getJiraIntegrationConfig } from './config.js';
import { createJiraClient } from './client.js';
import { getJiraListenerAttempt, recordJiraListenerAttempt, shouldRetryJiraIssue } from './links.js';

const MAX_ISSUES_PER_POLL = 20;

/**
 * Outbound polling listener that turns a Jira "issue action" into a session:
 * applying the configured trigger label to an issue makes the next poll start
 * an OpenChamber session for it. Polling is outbound-only, so it works for
 * Jira Cloud and Server/Data Center without exposing an inbound endpoint.
 *
 * Success marks the issue as handled permanently (and removes the trigger
 * label when permitted). Failures are recorded and posted to the issue; a
 * failed issue is retried when it changes after the failed attempt.
 */
export function createJiraIssueListener({
  sessionStarter,
  getConnection = getJiraConnection,
  getConfig = getJiraIntegrationConfig,
  createClient = createJiraClient,
  getAttempt = getJiraListenerAttempt,
  recordAttempt = recordJiraListenerAttempt,
  shouldRetry = shouldRetryJiraIssue,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let timer = null;
  let stopped = true;
  let ticking = false;
  const inFlight = new Set();

  const handleIssue = async (client, config, issue) => {
    const issueKey = issue.key;
    inFlight.add(issueKey);
    try {
      let result;
      try {
        result = await sessionStarter.startSessionFromIssue({
          issueKey,
          source: 'listener',
        });
      } catch (error) {
        const message = error?.message || 'Failed to start session';
        // Record the failure before commenting so a comment-triggered update
        // cannot re-trigger the same failure in a loop.
        recordAttempt(issueKey, { outcome: 'failed', error: message });
        console.warn(`[Jira] Failed to start session for ${issueKey}:`, message);
        if (config.updates.failed) {
          try {
            await client.addComment(issueKey, `OpenChamber could not start a session for this issue: ${message}`);
          } catch (commentError) {
            console.warn(`[Jira] Failed to post failure comment for ${issueKey}:`, commentError?.message || commentError);
          }
        }
        return;
      }

      recordAttempt(issueKey, { outcome: 'started', sessionId: result.sessionId });

      if (config.issueListener.removeTriggerLabel) {
        try {
          await client.removeLabel(issueKey, config.issueListener.triggerLabel);
        } catch (error) {
          // Label edits can be blocked by permissions or screen configuration.
          // The attempt record already prevents re-triggering.
          console.warn(`[Jira] Could not remove trigger label from ${issueKey}:`, error?.message || error);
        }
      }
    } finally {
      inFlight.delete(issueKey);
    }
  };

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      // Connection and config are resolved on every poll so settings changes
      // apply without a restart.
      const connection = getConnection();
      const config = getConfig();
      if (!connection || !config.issueListener.enabled) return;

      const client = createClient(connection);
      const label = config.issueListener.triggerLabel;
      const jql = `labels = "${label}" AND statusCategory != Done ORDER BY updated DESC`;
      let issues;
      try {
        issues = await client.searchIssues(jql, {
          maxResults: MAX_ISSUES_PER_POLL,
          fields: 'summary,project,labels,updated',
        });
      } catch (error) {
        console.warn('[Jira] Issue listener poll failed:', error?.message || error);
        return;
      }

      for (const issue of issues) {
        if (typeof issue?.key !== 'string' || !issue.key) continue;
        if (inFlight.has(issue.key)) continue;
        const attempt = getAttempt(issue.key);
        const updatedMs = Date.parse(issue?.fields?.updated || '');
        if (!shouldRetry(attempt, Number.isFinite(updatedMs) ? updatedMs : null)) continue;
        await handleIssue(client, config, issue);
      }
    } finally {
      ticking = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    const config = getConfig();
    timer = setTimeoutImpl(async () => {
      try {
        await tick();
      } finally {
        schedule();
      }
    }, config.issueListener.intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    schedule();
  };

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  };

  return {
    start,
    stop,
    tick,
    isRunning: () => !stopped,
  };
}
