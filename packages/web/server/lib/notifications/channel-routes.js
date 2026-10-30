import express from 'express';

/**
 * The routes behind the account card of an extension notification channel
 * (Settings → Integrations). They answer what `extension-channels.js` knows
 * and never a token:
 *
 * - `GET /api/notifications/channels` → `{ channels: [{ providerId, guestId, name, channel, account | null }] }`
 * - `PUT /api/notifications/channels/:providerId/account` `{ token, username?, instance? }` → `{ channel }` (the public view)
 * - `DELETE /api/notifications/channels/:providerId/account` → `{ removed }`
 *
 * A failure is `{ error, code }` with the status the channels module gave:
 * 404 `CHANNEL_UNKNOWN`, 400 `TOKEN_REQUIRED` / `USERNAME_REQUIRED` /
 * `USERNAME_INVALID` / `INSTANCE_REQUIRED` / `UNSUPPORTED_INSTANCE`, 401 `TOKEN_REFUSED`, 503
 * `CHANNEL_UNAVAILABLE`, 502 `MALFORMED_PROVIDER_RESPONSE`. A store that cannot
 * be read is 500, never an empty list.
 */
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
