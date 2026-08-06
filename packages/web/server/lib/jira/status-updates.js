import { getJiraConnection } from './auth.js';
import { getJiraIntegrationConfig } from './config.js';
import { createJiraClient } from './client.js';

const MAX_WATCHED_SESSIONS = 100;
const MAX_ERROR_CHARS = 400;
// A stray session.idle can arrive right around watch start (before the
// dispatched prompt marks the session busy). Real turns take longer than
// this, so an idle inside the grace window is not treated as completion.
const IDLE_GRACE_MS = 5_000;

/**
 * Turn an OpenCode `session.error` payload into a short human-readable line
 * suitable for a Jira comment.
 */
export function formatJiraSessionError(raw) {
  if (!raw) return 'OpenCode session error';
  if (typeof raw === 'string') return raw.trim() || 'OpenCode session error';
  let msg = (typeof raw.message === 'string' && raw.message)
    || (typeof raw.data?.message === 'string' && raw.data.message)
    || (typeof raw.error?.message === 'string' && raw.error.message)
    || '';
  if (!msg) {
    try {
      msg = JSON.stringify(raw);
    } catch {
      msg = String(raw);
    }
  }
  const firstLine = String(msg).trim().split('\n')[0].trim() || 'OpenCode session error';
  return firstLine.length > MAX_ERROR_CHARS ? `${firstLine.slice(0, MAX_ERROR_CHARS)}…` : firstLine;
}

/**
 * Watches linked sessions on the live global event stream and posts concise
 * lifecycle comments (attention-required, completed, failed) back to the
 * originating Jira issue.
 *
 * Watchers live in memory only: lifecycle state is derived from the live
 * event channel, and a restarted server has no authoritative view of turns
 * that ran while it was down, so it intentionally does not resume watching.
 */
export function createJiraStatusUpdates({
  globalEventHub,
  ensureEventStream = null,
  getConnection = getJiraConnection,
  getConfig = getJiraIntegrationConfig,
  createClient = createJiraClient,
}) {
  const watched = new Map();
  let unsubscribe = null;

  const postComment = async (issueKey, text) => {
    // Resolve connection state at post time; a disconnect while a session is
    // running must stop updates instead of using stale credentials.
    const connection = getConnection();
    if (!connection) {
      console.warn(`[Jira] Skipping status comment for ${issueKey}: Jira is no longer connected`);
      return false;
    }
    try {
      await createClient(connection).addComment(issueKey, text);
      return true;
    } catch (error) {
      console.warn(`[Jira] Failed to post status comment for ${issueKey}:`, error?.message || error);
      return false;
    }
  };

  const unwatch = (sessionId) => {
    watched.delete(sessionId);
    if (watched.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const sessionLine = (entry) => (entry.sessionUrl
    ? `Session: ${entry.sessionUrl}`
    : `Session id: ${entry.sessionId}`);

  const handleEvent = async ({ payload }) => {
    const type = payload?.type;
    if (typeof type !== 'string') return;
    const props = payload?.properties;
    const sessionId = props?.sessionID ?? props?.sessionId ?? null;
    if (!sessionId) return;
    const entry = watched.get(sessionId);
    if (!entry) return;

    if (type === 'session.deleted' || type === 'session.removed') {
      unwatch(sessionId);
      return;
    }

    const config = getConfig();

    if (type === 'permission.asked' || type === 'question.asked') {
      if (!config.updates.attention) return;
      const requestId = typeof props?.id === 'string' ? props.id : `${type}:${Date.now()}`;
      if (entry.attentionPosted.has(requestId)) return;
      entry.attentionPosted.add(requestId);
      const kind = type === 'permission.asked' ? 'a permission request' : 'a question';
      await postComment(entry.issueKey, [
        `OpenChamber session "${entry.title}" needs attention: the agent is waiting on ${kind}.`,
        sessionLine(entry),
      ].join('\n'));
      return;
    }

    if (type === 'session.error') {
      unwatch(sessionId);
      if (!config.updates.failed) return;
      const errorText = formatJiraSessionError(props?.error);
      await postComment(entry.issueKey, [
        `OpenChamber session "${entry.title}" failed: ${errorText}`,
        sessionLine(entry),
      ].join('\n'));
      return;
    }

    if (type === 'session.idle') {
      if (Date.now() - entry.watchedAt < IDLE_GRACE_MS) return;
      unwatch(sessionId);
      if (!config.updates.completed) return;
      await postComment(entry.issueKey, [
        `OpenChamber session "${entry.title}" completed its run for this issue.`,
        `Review the result and follow up in the session if needed.`,
        sessionLine(entry),
      ].join('\n'));
    }
  };

  const watchSession = ({ sessionId, issueKey, sessionUrl = null, title = null }) => {
    if (typeof sessionId !== 'string' || !sessionId || typeof issueKey !== 'string' || !issueKey) {
      return false;
    }
    if (!globalEventHub) return false;
    if (watched.size >= MAX_WATCHED_SESSIONS && !watched.has(sessionId)) {
      console.warn(`[Jira] Not watching session ${sessionId}: watcher limit reached`);
      return false;
    }
    watched.set(sessionId, {
      sessionId,
      issueKey,
      sessionUrl,
      title: title || sessionId,
      watchedAt: Date.now(),
      attentionPosted: new Set(),
    });
    if (!unsubscribe) {
      try {
        ensureEventStream?.();
      } catch {
        // The hub reconnects on its own; watching stays armed.
      }
      unsubscribe = globalEventHub.subscribeEvent(handleEvent);
    }
    return true;
  };

  const stop = () => {
    watched.clear();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  return {
    watchSession,
    stop,
    watchedCount: () => watched.size,
  };
}
