import express from 'express';
import type { Application, Response } from '../shared/http-contracts.js';
import type { createExtensionNotificationChannels } from './extension-channels.js';
import { hasErrorProperties, isNumber, isRequestBodyObject } from './inputs.js';
import type { NotificationFailure } from './inputs.js';

export const registerNotificationChannelRoutes = (app: Application, { channels }: {
  channels: Pick<ReturnType<typeof createExtensionNotificationChannels>, 'list' | 'connect' | 'disconnect'>;
}) => {
  const json16 = express.json({ limit: '16kb' });

  const answerFailure = (res: Response, error: NotificationFailure | undefined) => {
    const candidate = error?.status;
    const status = isNumber(candidate) && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
    res.status(status).json({ error: error?.message ?? 'Request failed', code: error?.code ?? 'INTERNAL_ERROR' });
  };

  app.get('/api/notifications/channels', async (_req, res) => {
    try {
      res.json({ channels: await channels.list() });
    } catch (error) {
      answerFailure(res, hasErrorProperties(error) ? error : undefined);
    }
  });

  app.put<unknown, { providerId: string }>('/api/notifications/channels/:providerId/account', json16, async (req, res) => {
    const body = isRequestBodyObject(req.body) ? req.body : {};
    try {
      const channel = await channels.connect({
        providerId: req.params.providerId,
        instance: body.instance,
        token: body.token,
        username: body.username,
      });
      res.json({ channel });
    } catch (error) {
      answerFailure(res, hasErrorProperties(error) ? error : undefined);
    }
  });

  app.delete<unknown, { providerId: string }>('/api/notifications/channels/:providerId/account', async (req, res) => {
    try {
      res.json(await channels.disconnect({ providerId: req.params.providerId }));
    } catch (error) {
      answerFailure(res, hasErrorProperties(error) ? error : undefined);
    }
  });
};
