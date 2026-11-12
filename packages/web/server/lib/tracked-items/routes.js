import express from 'express';
import { parseTrackedItems } from './items.js';

// One client shows at most this many linked items at once; the sidebar of a
// large workspace stays far below it.
const MAX_ITEMS = 300;

const text = (value) => (Object.prototype.toString.call(value) === '[object String]' ? value.trim() : '');

/**
 * `POST /api/tracked-items/interest` replaces what one event-stream connection
 * shows and answers with what is already known; changes then arrive as
 * `openchamber:tracked-items.changed` on that connection. Presence and refresh
 * are single signals, sent when they happen, never on a timer.
 */
export function registerTrackedItemsRoutes(app, { service }) {
  const json = express.json({ limit: '128kb' });

  app.post('/api/tracked-items/interest', json, async (req, res) => {
    const connectionId = text(req.body?.connectionId);
    const items = parseTrackedItems(req.body?.items, MAX_ITEMS);
    if (!connectionId || !items) {
      return res.status(400).json({ error: `connectionId and at most ${MAX_ITEMS} items are required` });
    }
    await service.ready();
    try {
      return res.json({ states: service.setInterest(connectionId, items, { visible: req.body?.visible !== false }) });
    } catch (error) {
      if (error?.code === 'unknown-connection') return res.status(409).json({ error: error.message, code: error.code });
      throw error;
    }
  });

  app.post('/api/tracked-items/presence', json, (req, res) => {
    const connectionId = text(req.body?.connectionId);
    if (!connectionId || (req.body?.visible !== true && req.body?.visible !== false)) {
      return res.status(400).json({ error: 'connectionId and visible are required' });
    }
    service.setPresence(connectionId, req.body.visible);
    return res.json({ ok: true });
  });

  app.post('/api/tracked-items/refresh', json, (req, res) => {
    const items = parseTrackedItems(req.body?.items, MAX_ITEMS);
    if (!items) return res.status(400).json({ error: `at most ${MAX_ITEMS} items are required` });
    service.refresh([...items.values()]);
    return res.json({ ok: true });
  });
}
