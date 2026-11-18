import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createNotificationCenterRuntime, createNotificationCenterPersistence } from './center.js';
import { createNotificationEmitterRuntime } from './emitter-runtime.js';
import { createNotificationTriggerRuntime } from './runtime.js';
import { createBotAttention } from '../bots/attention.js';
import { createBotItem } from '../bots/schema.js';
import { isNumber } from '../shared/guards.js';

/** The owner coordinator creates, persists, alerts and resolves a sessionless item. */
export async function runOwnerBotAttentionDriver({ settings = {}, focused = false, visible = false, critical = false } = {}) {
  const dataDir = await fs.mkdtemp('/tmp/opencode/bot-owner-attention-');
  const emitted = []; const desktop = []; const webPush = []; const apns = [];
  const emitter = createNotificationEmitterRuntime({ process,
    getDesktopNotifyEnabled: () => true, onDesktopNotification: (event) => desktop.push(event),
    getUiNotificationClients: () => new Set(), getBroadcastGlobalUiEvent: () => (event) => emitted.push(event) });
  let center = createNotificationCenterRuntime({ persistence: createNotificationCenterPersistence({ dataDir }),
    broadcast: (event) => emitted.push(event) });
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', ...settings }),
    getIsWindowFocused: () => focused, isAnyInteractiveClientVisible: () => visible,
    emitDesktopNotification: emitter.emitDesktopNotification, broadcastUiNotification: emitter.broadcastUiNotification,
    sendPushToAllUiSessions: async (payload, options) => webPush.push({ payload, options }),
    sendApnsToAllUiSessions: async (payload, options) => apns.push({ payload, options }),
    fetchImpl: async () => { throw new Error('Sessionless owner attention must not read a project'); },
    buildTemplateVariables: async () => { throw new Error('Sessionless owner attention must not read metadata'); },
  });
  try {
    const attention = createBotAttention({ center, notify: runtime.notifyBotAttention });
    const item = createBotItem({ id: 'item-one', botId: 'bot-one', source: { kind: 'manual', id: 'manual-one' }, title: 'Private bot title' });
    const pending = { ...item, state: 'needs-you', wait: { since: 0, channel: 'ui', reason: 'Private question' } };
    await attention.sync({ projectId: 'project/one', item: pending, critical });
    const [entry] = await center.list({ allKinds: true });
    assert(entry); assert.equal(entry.sessionId, null); assert.equal(entry.resolvedAt, null);
    assert.deepEqual(entry.action, { type: 'bots', projectId: 'project/one', itemId: item.id });
    await center.markRead({ ids: [entry.id] });
    await attention.sync({ projectId: 'project/one', item: pending });
    assert.equal((await center.list({ allKinds: true })).length, 1);
    const alerts = desktop.length;
    await center.stop();
    center = createNotificationCenterRuntime({ persistence: createNotificationCenterPersistence({ dataDir }),
      broadcast: (event) => emitted.push(event) });
    const restored = (await center.list({ allKinds: true }))[0];
    assert.equal(restored.id, entry.id); assert(isNumber(restored.readAt));
    const freshAttention = createBotAttention({ center, notify: runtime.notifyBotAttention });
    await freshAttention.sync({ projectId: 'project/one', item: pending });
    assert.equal(desktop.length, alerts, 'Restart must not replay the pending alert');
    await freshAttention.sync({ projectId: 'project/one', item: { ...pending, state: 'fixing' } });
    const entries = await center.list({ allKinds: true });
    assert.equal(entries.length, 1); assert.equal(entries[0].id, entry.id);
    assert(isNumber(entries[0].resolvedAt));
    return { emitted, desktop, webPush, apns, entries };
  } finally { await center.stop(); await fs.rm(dataDir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runOwnerBotAttentionDriver();
  assert.equal(result.desktop.length, 1); assert.equal(result.webPush.length, 1); assert.equal(result.apns.length, 1);
  assert.equal(result.emitted.filter((event) => event.type === 'openchamber:notification').length, 1);
  console.log('PASS owner-created Bot attention: pending -> persisted restart -> resolved before a session exists, one desktop/UI/web-push/APNs alert, exact Bots target. No agent attention bridge or external push.');
}
