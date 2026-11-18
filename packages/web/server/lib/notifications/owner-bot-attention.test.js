import { afterEach, expect, it, vi } from 'vitest';
import { runOwnerBotAttentionDriver } from './owner-bot-attention.driver.mjs';
import { parseAgentStreamEvent } from '../agent-server/agent-stream-schemas.js';

afterEach(() => vi.unstubAllEnvs());

it('creates durable sessionless attention on the owner and resolves the same entry after restart', async () => {
  const result = await runOwnerBotAttentionDriver();
  expect(result.desktop).toHaveLength(1);
  expect(result.emitted.filter((event) => event.type === 'openchamber:notification')).toHaveLength(1);
  expect(result.desktop[0]).toMatchObject({ kind: 'bot', botTarget: { projectId: 'project/one', itemId: 'item-one' } });
  expect(result.webPush).toHaveLength(1); expect(result.apns).toHaveLength(1);
  expect(result.webPush[0]).toMatchObject({ payload: { data: { type: 'bot', url: '/?botsProject=project%2Fone&botItem=item-one' } }, options: { requireNoSse: true } });
  expect(result.entries[0]).toMatchObject({ kind: 'bot', sessionId: null, action: { type: 'bots', projectId: 'project/one', itemId: 'item-one' }, resolvedAt: expect.any(Number) });
  expect(result.entries[0]).not.toHaveProperty('agentOwned');
});

it.each([
  [{ settings: { notifyOnQuestion: false } }, 0, 0],
  [{ settings: { notifyOnError: false }, critical: true }, 0, 0],
  [{ settings: { notificationMode: 'hidden-only' }, focused: true }, 0, 0],
  [{ settings: { nativeNotificationsEnabled: false } }, 0, 1],
  [{ visible: true }, 1, 1],
])('uses owner preferences without losing attention history %#', async (options, desktopCount, pushCount) => {
  const result = await runOwnerBotAttentionDriver(options);
  expect(result.desktop).toHaveLength(desktopCount); expect(result.webPush).toHaveLength(pushCount);
  expect(result.apns).toHaveLength(options.visible ? 0 : pushCount);
  expect(result.entries[0].resolvedAt).toEqual(expect.any(Number));
});

it('retains local Bot text but strips enterprise push content at the owner boundary', async () => {
  vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', 'true');
  const result = await runOwnerBotAttentionDriver();
  expect(result.desktop[0].body).toBe('Private question');
  expect(JSON.stringify([result.webPush, result.apns])).not.toContain('Private');
  expect(result.webPush[0].payload.body).toBe(''); expect(result.apns[0].payload.body).toBe('');
  expect(result.apns[0].payload.sealed).toBeUndefined();
});

it.each([
  ['openchamber:bot-attention', { change: 'snapshot', entries: [] }],
  ['openchamber:bots-changed', { projectId: 'project' }],
  ['openchamber:notification', { kind: 'bot', botTarget: { projectId: 'project', itemId: 'item' }, critical: false,
    title: 'Ask', body: 'No agent coordinator', tag: 'bot-item', sessionId: null }],
])('refuses agent-owned Bot control or attention event %s', (type, properties) => {
  for (const source of ['notifications', 'control']) {
    expect(parseAgentStreamEvent({ type, properties }, source, { warn() {} })).toBeNull();
  }
});
