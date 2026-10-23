import { describe, expect, it, vi } from 'vitest';
import { createNotificationCenterRuntime } from '../notifications/center.js';
import { createBotAttention } from './attention.js';
import { createBotItem } from './schema.js';
import { runAttentionDriver } from './attention-driver.mjs';

describe('bot attention', () => {
  it('drives durable upsert, change, retention, item-only resolution and restart', async () => {
    expect(await runAttentionDriver()).toMatchObject({ alerts: 2, target: { type: 'bots', itemId: 'item' } });
  });

  it('rejects failed authority reads and invalid items without resolving anything', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const persistence = { load: async () => { throw new Error('read failed'); }, save: vi.fn() };
    const center = createNotificationCenterRuntime({ persistence });
    const attention = createBotAttention({ center, notify: vi.fn() });
    const item = createBotItem({ botId: 'bot', source: { kind: 'manual', id: 'source' }, title: 'Title' });
    try {
      await expect(attention.sync({ projectId: 'project', item })).rejects.toThrow('read failed');
      await expect(attention.sync({ projectId: 'project', item: null })).rejects.toThrow();
      expect(persistence.save).not.toHaveBeenCalled();
    } finally {
      await center.stop();
      warn.mockRestore();
    }
  });

  it('keeps pending state and retries a failed durable resolution', async () => {
    const persistence = { load: async () => [], save: vi.fn(async () => {}) };
    const center = createNotificationCenterRuntime({ persistence });
    await center.upsertBot({ projectId: 'p', itemId: 'i', title: 'Title', body: 'Question' });
    persistence.save.mockRejectedValueOnce(new Error('disk full'));
    await expect(center.resolveBot({ projectId: 'p', itemId: 'i' })).rejects.toThrow('disk full');
    expect((await center.list({ allKinds: true }))[0].resolvedAt).toBeNull();
    expect(await center.resolveBot({ projectId: 'p', itemId: 'i' })).toHaveLength(1);
    await center.stop();
  });

  it('retries failed upserts and serializes concurrent changes without duplicate requests', async () => {
    const persistence = { load: async () => [], save: vi.fn(async () => {}) };
    const broadcast = vi.fn();
    const center = createNotificationCenterRuntime({ persistence, broadcast });
    const input = { projectId: 'p', itemId: 'i', title: 'Title', body: 'Question' };
    persistence.save.mockRejectedValueOnce(new Error('disk full'));
    await expect(center.upsertBot(input)).rejects.toThrow('disk full');
    expect(await center.list({ allKinds: true })).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([center.upsertBot(input), center.upsertBot(input)]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await center.list({ allKinds: true })).toHaveLength(1);
    await center.stop();
  });

  it('alerts on a needs-you transition with the same question and resolves without alerting on progress', async () => {
    const center = createNotificationCenterRuntime({ persistence: { load: async () => [], save: async () => {} } });
    const notify = vi.fn();
    const attention = createBotAttention({ center, notify });
    const base = createBotItem({ botId: 'bot', source: { kind: 'manual', id: 'source' }, title: 'Title' });
    const waiting = { ...base, wait: { reason: 'Approval needed', since: 1, channel: 'ui', people: [] } };
    const input = { projectId: 'p', item: { ...waiting, state: 'waiting-answer' } };
    await attention.sync(input);
    await attention.sync({ ...input, item: { ...waiting, state: 'needs-you' } });
    expect(notify).toHaveBeenCalledTimes(1);
    await attention.sync({ ...input, item: { ...base, state: 'fixing' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await center.list({ allKinds: true }))[0].resolvedAt).not.toBeNull();
    await center.stop();
  });
});
