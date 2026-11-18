import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotificationCenterPersistence, createNotificationCenterRuntime, NOTIFICATION_CENTER_LIMIT, NOTIFICATION_CENTER_TTL_MS } from '../notifications/center.js';
import { createBotAttention } from './attention.js';
import { createBotItem } from './schema.js';

export async function runAttentionDriver() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-bot-attention-'));
  let center;
  try {
    let clock = 1;
    const broadcasts = [];
    const alerts = [];
    const persistence = createNotificationCenterPersistence({ dataDir });
    const construct = () => createNotificationCenterRuntime({ persistence, now: () => clock, broadcast: (event) => broadcasts.push(event) });
    center = construct();
    let attention = createBotAttention({ center, notify: async (payload) => alerts.push(payload) });
    const base = createBotItem({ id: 'item', botId: 'bot', title: 'Review change', source: { kind: 'manual', id: 'source' }, now: 1 });
    let item = { ...base, state: 'waiting-answer', wait: { reason: 'Which approach?', since: 1, channel: 'ui', people: [] } };
    const sync = (critical = false) => attention.sync({ projectId: 'project', item, critical });
    const first = await sync();
    assert.equal((await persistence.load())[0].requestId, item.id);
    assert.equal(first.sessionId, null);
    assert.equal(first.requestId, item.id);
    assert.deepEqual(first.action, { type: 'bots', projectId: 'project', itemId: 'item' });
    const events = broadcasts.length;
    assert.equal((await sync()).id, first.id);
    assert.equal(broadcasts.length, events);
    assert.equal(alerts.length, 0);
    await center.markRead({ all: true });
    item = { ...item, state: 'needs-you', wait: { ...item.wait, reason: 'Approval needed' } };
    assert.equal((await sync()).readAt, null);
    await sync();
    assert.equal(alerts.length, 1);
    await sync(true);
    assert.equal(alerts.length, 2);
    clock += NOTIFICATION_CENTER_TTL_MS + 1;
    for (let index = 0; index <= NOTIFICATION_CENTER_LIMIT; index++) {
      await center.record({ kind: 'ready', priority: 'normal', delivery: 'quiet', title: 'Done', body: '' });
    }
    assert.equal((await center.list({ allKinds: true })).length, NOTIFICATION_CENTER_LIMIT + 1);
    assert.deepEqual(await center.remove([first.id]), []);
    await center.clear();
    assert.equal((await center.list({ allKinds: true })).length, 1);
    await center.stop();
    center = construct();
    attention = createBotAttention({ center, notify: async (payload) => alerts.push(payload) });
    assert.equal((await sync()).id, first.id);
    assert.equal(alerts.length, 2);
    await center.resolveBot({ projectId: 'other', itemId: item.id });
    assert.equal((await center.list({ allKinds: true }))[0].resolvedAt, null);
    item = { ...item, state: 'fixing' };
    await sync();
    await sync();
    await center.stop();
    center = construct();
    assert.equal((await center.list({ allKinds: true })).filter((entry) => entry.resolvedAt === null).length, 0);
    return { alerts: alerts.length, target: first.action, retention: NOTIFICATION_CENTER_LIMIT };
  } finally {
    await center?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(await runAttentionDriver()));
}
