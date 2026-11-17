import express from 'express';

import { asControlError } from '../openchamber-control/error.js';

const BASE = '/api/openchamber/sessions/:sessionId/share-pages/:callId';

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

const RECEIVED = '/api/openchamber/received-pages';

export const registerReceivedPageRoutes = (app, runtime) => {
  app.get(`${RECEIVED}/config`, handle('Could not read the shared pages settings', () => runtime.config()));
  app.get(RECEIVED, handle('Could not read the shared pages', () => runtime.list()));
  app.post(RECEIVED, express.json({ limit: '16kb' }), handle('Could not read the share link', (req) => runtime.register(req.body?.url)));
  app.get(`${RECEIVED}/:receivedId`, handle('Could not read the shared page', (req) => runtime.get(req.params.receivedId)));
  app.post(`${RECEIVED}/:receivedId/status`, handle('Could not read the shared page', (req) => runtime.refreshStatus(req.params.receivedId)));
  app.post(`${RECEIVED}/:receivedId/open`, express.json({ limit: '16kb' }), handle('Could not open the shared page', (req) => (
    runtime.open(req.params.receivedId, req.body?.pin)
  )));
  app.get(`${RECEIVED}/:receivedId/document`, handle('Could not read the shared page', (req) => runtime.document(req.params.receivedId)));
  app.post(`${RECEIVED}/:receivedId/answer`, express.json({ limit: '64kb' }), handle('Could not send the answer', (req) => (
    runtime.answer(req.params.receivedId, req.body)
  )));
};

export const registerSharePageRoutes = (app, runtime) => {

  app.get(BASE, handle('Could not read the shared page', (req) => runtime.getGroup(req.params.sessionId, req.params.callId)));

  app.post(`${BASE}/document`, express.json({ limit: '40mb' }), handle('Could not share the page', (req) => (
    runtime.uploadDocument(req.params.sessionId, req.params.callId, { html: req.body?.html, title: req.body?.title, source: req.body?.source })
  )));

  app.post(`${BASE}/recipients/:recipientId/cancel`, handle('Could not withdraw the link', (req) => (
    runtime.cancelRecipient(req.params.sessionId, req.params.callId, req.params.recipientId)
  )));

  app.get(`${BASE}/preview`, handle('Could not read the shared page', (req) => runtime.preview(req.params.sessionId, req.params.callId)));
};
