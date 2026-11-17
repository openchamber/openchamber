import express from 'express';

export const registerNotificationChannelRoutes = (app, { channels }) => {
  const json16 = express.json({ limit: '16kb' });

  const answerFailure = (res, error) => {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    res.status(status).json({ error: error?.message ?? 'Request failed', code: error?.code ?? 'INTERNAL_ERROR' });
  };

  app.get('/api/notifications/channels', async (_req, res) => {
    try {
      res.json({ channels: await channels.list() });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.put('/api/notifications/channels/:providerId/account', json16, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const channel = await channels.connect({
        providerId: req.params.providerId,
        instance: body.instance,
        token: body.token,
        username: body.username,
      });
      res.json({ channel });
    } catch (error) {
      answerFailure(res, error);
    }
  });

  app.delete('/api/notifications/channels/:providerId/account', async (req, res) => {
    try {
      res.json(await channels.disconnect({ providerId: req.params.providerId }));
    } catch (error) {
      answerFailure(res, error);
    }
  });
};
