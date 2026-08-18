/**
 * What a session still owes in project knowledge, and the record that it was
 * delivered.
 *
 * Two calls rather than one, because only the sender knows whether the message
 * carrying the block actually went out. Handing over the text and recording it
 * as delivered in the same request would leave a failed send believing the
 * agent has context it never received.
 *
 * The body parser is attached per route: there is no global one, because the
 * generic OpenCode proxy needs an unread request stream.
 */

import express from 'express';

const parseJsonBody = express.json({ limit: '1mb' });

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asNonEmptyString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

export const registerSessionKnowledgeRoutes = (app, dependencies) => {
  const { sessionKnowledgeRuntime } = dependencies;

  /**
   * Answers with the text to attach and the signature to report back once it
   * has gone. An empty text means the session is already carrying it.
   */
  app.get('/api/session-knowledge', async (req, res) => {
    const directory = asNonEmptyString(req.query.directory);
    const sessionId = asNonEmptyString(req.query.sessionId);
    if (!directory) {
      return res.status(400).json({ error: 'directory is required' });
    }

    try {
      const pending = sessionId
        ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionId, directory)
        // A session that does not exist yet — a draft about to be created —
        // has been told nothing, so everything is still owed.
        : await sessionKnowledgeRuntime.resolvePending(directory, '');
      return res.json(pending);
    } catch (error) {
      // Never fails the caller's send: a message without its background is far
      // better than no message at all.
      return res.json({ text: '', signature: '', unavailable: true, reason: error?.message ?? 'unknown' });
    }
  });

  /** Counts and names for the work status panel; assembles no text. */
  app.get('/api/session-knowledge/summary', async (req, res) => {
    const directory = asNonEmptyString(req.query.directory);
    if (!directory) {
      return res.json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
    }
    try {
      return res.json(await sessionKnowledgeRuntime.collectSummary(directory));
    } catch {
      // A panel that cannot read this shows nothing rather than an error.
      return res.json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
    }
  });

  app.post('/api/session-knowledge/delivered', parseJsonBody, async (req, res) => {
    const body = req.body;
    if (!isRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    const sessionId = asNonEmptyString(body.sessionId);
    const directory = asNonEmptyString(body.directory);
    const signature = asNonEmptyString(body.signature);
    if (!sessionId || !directory || !signature) {
      return res.status(400).json({ error: 'sessionId, directory and signature are required' });
    }

    try {
      await sessionKnowledgeRuntime.recordDelivered(sessionId, directory, signature);
      return res.json({ recorded: true });
    } catch (error) {
      // The message is already sent; failing here only means the block may be
      // sent once more, which is far better than reporting the send as failed.
      return res.json({ recorded: false, reason: error?.message ?? 'unknown' });
    }
  });
};
