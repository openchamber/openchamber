import express from 'express';
import { parseTrackedItems } from './items.js';
import type { Application } from '../shared/http-contracts.js';
import type { createTrackedItemsService } from './service.js';

const MAX_ITEMS = 300;

const isText = (value: unknown): value is { trim(): string } => Object.prototype.toString.call(value) === '[object String]';

const hasBodyFields = (value: unknown): value is { connectionId?: unknown; items?: unknown; visible?: unknown } => (
  value !== null && (typeof value === 'object' || typeof value === 'function')
);
const isUnknownConnection = (value: unknown): value is { code: 'unknown-connection'; message?: unknown } => (
  value !== null && (typeof value === 'object' || typeof value === 'function')
  && 'code' in value && value.code === 'unknown-connection'
);

export function registerTrackedItemsRoutes(app: Application, { service }: {
  service: Pick<ReturnType<typeof createTrackedItemsService>, 'ready' | 'setInterest' | 'setPresence' | 'refresh'>;
}) {
  const json = express.json({ limit: '128kb' });

  app.post('/api/tracked-items/interest', json, async (req, res) => {
    const body = hasBodyFields(req.body) ? req.body : undefined;
    const connectionId = isText(body?.connectionId) ? body.connectionId.trim() : '';
    const items = parseTrackedItems(Array.isArray(body?.items) ? body.items : undefined, MAX_ITEMS);
    if (!connectionId || !items) {
      return res.status(400).json({ error: `connectionId and at most ${MAX_ITEMS} items are required` });
    }
    await service.ready();
    try {
      return res.json({ states: service.setInterest(connectionId, items, { visible: body?.visible !== false }) });
    } catch (error) {
      if (isUnknownConnection(error)) return res.status(409).json({ error: error.message, code: error.code });
      throw error;
    }
  });

  app.post('/api/tracked-items/presence', json, (req, res) => {
    const body = hasBodyFields(req.body) ? req.body : undefined;
    const connectionId = isText(body?.connectionId) ? body.connectionId.trim() : '';
    if (!connectionId || (body?.visible !== true && body?.visible !== false)) {
      return res.status(400).json({ error: 'connectionId and visible are required' });
    }
    service.setPresence(connectionId, body.visible);
    return res.json({ ok: true });
  });

  app.post('/api/tracked-items/refresh', json, (req, res) => {
    const body = hasBodyFields(req.body) ? req.body : undefined;
    const items = parseTrackedItems(Array.isArray(body?.items) ? body.items : undefined, MAX_ITEMS);
    if (!items) return res.status(400).json({ error: `at most ${MAX_ITEMS} items are required` });
    service.refresh([...items.values()]);
    return res.json({ ok: true });
  });
}
