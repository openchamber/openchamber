import express from 'express';

import { asControlError } from '../openchamber-control/error.js';

const BASE = '/api/openchamber/sessions/:sessionId/share-pages/:callId';

/**
 * The session card's side of a shared page, behind UI auth like every
 * OpenChamber route: the group with each recipient's link and PIN, the
 * document the chat built (sealed and uploaded here), withdrawing one link,
 * and the local copy for the author's preview.
 */
export const registerSharePageRoutes = (app, runtime) => {
  const handle = (fallback, work) => async (req, res) => {
    try {
      return res.json(await work(req));
    } catch (error) {
      const controlError = asControlError(error, fallback);
      const body = { error: controlError.message };
      if (controlError.code) body.code = controlError.code;
      return res.status(controlError.statusCode).json(body);
    }
  };

  app.get(BASE, handle('Could not read the shared page', (req) => runtime.getGroup(req.params.sessionId, req.params.callId)));

  // A page may inline up to 25 MB of images plus the renderer.
  app.post(`${BASE}/document`, express.json({ limit: '40mb' }), handle('Could not share the page', (req) => (
    runtime.uploadDocument(req.params.sessionId, req.params.callId, { html: req.body?.html, title: req.body?.title })
  )));

  app.post(`${BASE}/recipients/:recipientId/cancel`, handle('Could not withdraw the link', (req) => (
    runtime.cancelRecipient(req.params.sessionId, req.params.callId, req.params.recipientId)
  )));

  app.get(`${BASE}/preview`, handle('Could not read the shared page', (req) => runtime.preview(req.params.sessionId, req.params.callId)));
};
