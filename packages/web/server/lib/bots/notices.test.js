import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNoticeDriver } from './notices-test-support.js';
import { createBotNotices } from './notices.js';
import { registerMessageQueueRoutes, parseQueuedItemInput } from '../message-queue/runtime.js';

describe('bot notice delivery', () => {
  let root;
  let driver;
  beforeEach(async () => {
    root = await fs.mkdtemp('/tmp/opencode/bot-notices-');
    driver = await createNoticeDriver(root);
  });
  afterEach(async () => { await driver.close(); await fs.rm(root, { recursive: true, force: true }); });

  it('retains one durable queue ID when admission is retried concurrently and after restart', async () => {
    // Given a busy correction session and two receipts for the same event.
    const { notices, runtime, state } = driver;
    // When the same delivery races and is retried by a new runtime.
    const results = await Promise.all([notices.deliver(driver.request), notices.deliver(driver.request)]);
    runtime.stop(); await runtime.flush();
    const restored = driver.create();
    const retried = await restored.notices.deliver(driver.request);
    // Then there is one durable entry and all receipts name it.
    expect(new Set([...results, retried].map((entry) => entry.itemId)).size).toBe(1);
    expect(restored.runtime.sessionSnapshot(driver.sessionId).items).toHaveLength(1);
    expect(state.attempts).toEqual([]);
  });

  it('wakes the authoritative session once when a response is lost and the coordinator receipt is retried after restart', async () => {
    // Given an admitted remote effect whose response will be lost.
    await driver.notices.deliver(driver.request);
    driver.state.active = {}; driver.state.loseResponse = true;
    const failed = driver.nextSettled();
    driver.runtime.start();
    await failed;
    driver.runtime.stop(); await driver.runtime.flush();
    const restored = driver.create();
    const sent = driver.nextSent();
    // When restart re-enqueues the same event before either receipt was saved.
    const receipt = await restored.notices.deliver(driver.request);
    restored.runtime.start();
    await sent;
    restored.runtime.stop(); await restored.runtime.flush();
    const again = driver.create();
    const resent = driver.nextSent();
    await again.notices.deliver(driver.request);
    again.runtime.start(); await resent;
    // Then OpenCode admitted one synthetic row and every retry kept its ID.
    expect(driver.state.messages.size).toBe(1);
    expect(driver.state.attempts.every((entry) => entry.body.id === receipt.messageId)).toBe(true);
    expect([...driver.state.messages.values()][0]).toMatchObject({ sessionId: driver.sessionId, resume: true, delivery: 'steer', metadata: { source: 'openchamber-notice', kind: 'bot', projectId: driver.projectId, itemId: driver.itemId, eventId: 'event-1' } });
    expect(driver.state.switches).toEqual([]);
  });

  it.each(['investigation', 'judge'])('keeps memory-save guidance off when feedback wakes a read-only %s stage', async (stage) => {
    // Given a read-only current stage before a correction session exists.
    const sessionId = `ses_bot_${stage}`;
    await driver.changeItem((item) => ({ ...item, sessions: { [stage]: sessionId } }));
    driver.records.set(sessionId, driver.record(sessionId, stage));
    driver.state.active = {};
    const sent = driver.nextSent();
    // When the event is delivered.
    await driver.notices.deliver(driver.request); await sent;
    // Then the guard's stage policy reaches knowledge synchronization unchanged.
    expect(driver.state.knowledge).toEqual([[sessionId, driver.directory, { includeMemorySaveRule: false }]]);
    expect(driver.state.sent).toEqual([sessionId]);
  });

  it('uses current persisted sessions when the caller holds a stale detached item', async () => {
    // Given a detached item naming a former correction session.
    const stale = await driver.currentItem();
    const sessionId = 'ses_bot_new';
    await driver.changeItem((item) => ({ ...item, sessions: { fixing: sessionId } }));
    driver.records.set(sessionId, driver.record(sessionId, 'fixing'));
    // When a caller retries with that stale snapshot.
    const result = await driver.notices.deliver({ ...driver.request, item: stale });
    // Then admission names only the current persisted owner.
    expect(result.sessionId).toBe(sessionId);
    expect(driver.runtime.sessionSnapshot(driver.sessionId).items).toEqual([]);
  });

  it('queues independent provider events separately for the same bot item', async () => {
    // Given two distinct events for one busy correction session.
    const first = await driver.notices.deliver(driver.request);
    // When another event arrives with its own stable identity.
    const second = await driver.notices.deliver({ ...driver.request, eventId: 'event-2' });
    // Then neither event suppresses the other.
    expect(second.messageId).not.toBe(first.messageId);
    expect(driver.runtime.sessionSnapshot(driver.sessionId).items).toHaveLength(2);
  });

  it('reports a missing stage session as a refusal', async () => {
    // Given an item that has not created a stage session.
    await driver.changeItem((item) => ({ ...item, sessions: {} }));
    // When feedback arrives, then the caller receives a visible refusal.
    await expect(driver.notices.deliver(driver.request)).rejects.toMatchObject({ code: 'BOT_NOTICE_SESSION_MISSING' });
  });

  it.each([false, true])('delivers to recorded isolation=%s after the bot setting changes', async (isolated) => {
    const directory = isolated ? '/spaces/abcdef123456/repo' : driver.directory;
    driver.records.set(driver.sessionId, driver.record(driver.sessionId, 'fixing', { directory, isolated }));
    let queue;
    const notices = createBotNotices({ store: driver.store,
      config: { read: async () => ({ definitions: [{ id: 'bot', enabled: true, isolated: !isolated }] }) },
      readSession: async () => driver.records.get(driver.sessionId), queueFor: async () => queue });
    queue = driver.create({ botDispatchIsolated: isolated, assertBotDispatch: (input) => notices.assertDispatch(input) }).runtime;
    const receipt = await notices.deliver(driver.request);
    expect(receipt.sessionId).toBe(driver.sessionId);
    expect(queue.sessionSnapshot(driver.sessionId).items).toHaveLength(1);
    await expect(notices.assertDispatch({ sessionId: driver.sessionId, directory,
      origin: { kind: 'bot', id: driver.itemId }, isolated,
      notice: { source: 'openchamber-notice', kind: 'bot', projectId: driver.projectId, itemId: driver.itemId, eventId: 'event-1' },
    })).resolves.toEqual({ includeMemorySaveRule: true });
  });

  it('refuses isolated delivery through a host queue even when the resolver returns it', async () => {
    // Given a real isolated target and an incorrectly wired host queue.
    const isolatedDirectory = '/spaces/abcdef123456/repo';
    driver.records.set(driver.sessionId, driver.record(driver.sessionId, 'fixing', { directory: isolatedDirectory, isolated: true }));
    let queue;
    const isolated = createBotNotices({ store: driver.store,
      config: { read: async () => ({ definitions: [{ id: 'bot', enabled: true, isolated: true }] }) },
      readSession: async () => driver.records.get(driver.sessionId), queueFor: async () => queue });
    const guarded = driver.create({ assertBotDispatch: (input) => isolated.assertDispatch(input) });
    queue = guarded.runtime;
    // When admission tries the host queue, then its dispatch scope refuses it.
    await expect(isolated.deliver(driver.request)).rejects.toMatchObject({ code: 'BOT_NOTICE_TARGET_CHANGED' });
    expect(guarded.runtime.snapshot().sessions).toEqual([]);
  });

  it('delivers in an explicitly scoped isolated queue without a host fallback', async () => {
    // Given a queue whose transport is explicitly bound to the isolated target.
    driver.records.set(driver.sessionId, driver.record(driver.sessionId, 'fixing', { directory: '/spaces/abcdef123456/repo', isolated: true }));
    let queue;
    const notices = createBotNotices({ store: driver.store,
      config: { read: async () => ({ definitions: [{ id: 'bot', enabled: true, isolated: true }] }) },
      readSession: async () => driver.records.get(driver.sessionId), queueFor: async () => queue });
    queue = driver.create({ botDispatchIsolated: true, assertBotDispatch: (input) => notices.assertDispatch(input) }).runtime;
    driver.state.active = {};
    const sent = driver.nextSent();
    // When the recorded runtime admits feedback.
    await notices.deliver(driver.request); await sent;
    // Then only that scoped queue receives it.
    expect(driver.state.messages.size).toBe(1);
    expect(driver.state.knowledge[0]?.[1]).toBe('/spaces/abcdef123456/repo');
  });

  it('rejects admission until the queue write succeeds', async () => {
    // Given a filesystem that cannot create the queue's temporary file.
    const blocked = path.join(root, 'queue', `message-queue.json.${process.pid}.tmp`);
    await fs.mkdir(blocked, { recursive: true });
    // When a bot event attempts durable admission, then failure reaches its caller.
    await expect(driver.notices.deliver(driver.request)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(driver.state.attempts).toEqual([]);
    // A repeat after repair persists the same pending entry.
    await fs.rm(blocked, { recursive: true });
    await driver.notices.deliver(driver.request);
    expect(driver.runtime.sessionSnapshot(driver.sessionId).items).toHaveLength(1);
  });

  it('fails closed when the queue has no bot authority guard', async () => {
    // Given an otherwise valid delivery and an unconfigured queue.
    const { notices, runtime } = driver.create({ assertBotDispatch: undefined });
    // When the event arrives, then admission refuses it before any remote effect.
    await expect(notices.deliver(driver.request)).rejects.toMatchObject({ status: 409 });
    expect(runtime.snapshot().sessions).toEqual([]);
  });

  it('preserves admitted bot events when ordinary queue traffic reaches capacity', async () => {
    // Given a bot notice followed by enough composer messages to fill its queue.
    const admitted = await driver.notices.deliver(driver.request);
    const ordinary = { content: 'user', sendConfig: { providerID: 'p', modelID: 'm' } };
    for (let index = 1; index < 20; index += 1) await driver.runtime.enqueue(driver.sessionId, driver.directory, ordinary);
    // When another user message would evict the oldest entry.
    await expect(driver.runtime.enqueue(driver.sessionId, driver.directory, ordinary)).rejects.toMatchObject({ status: 409 });
    // Then the admitted bot notice remains recoverable.
    expect(driver.runtime.sessionSnapshot(driver.sessionId).items[0]?.id).toBe(admitted.itemId);
  });

  it.each(['directory', 'metadata', 'isolation'])('refuses forged %s authority before admission', async (field) => {
    // Given a session record that disagrees with its persisted bot owner.
    const current = driver.records.get(driver.sessionId);
    const changed = field === 'directory' ? { ...current, directory: '/other' }
      : field === 'metadata' ? { ...current, metadata: { openchamber: { automation: { ...current.metadata.openchamber.automation, itemId: 'other' } } } }
        : { ...current, directory: '/spaces/abcdef123456/repo' };
    driver.records.set(driver.sessionId, changed);
    // When admission is attempted, then neither queue nor OpenCode gains a row.
    await expect(driver.notices.deliver(driver.request)).rejects.toMatchObject({ status: 409 });
    expect(driver.runtime.snapshot().sessions).toEqual([]);
    expect(driver.state.messages.size).toBe(0);
  });

  it('refuses dispatch when a queued session is no longer the current owner', async () => {
    // Given a durable notice whose owning session was replaced while busy.
    await driver.notices.deliver(driver.request);
    await driver.changeItem((item) => ({ ...item, sessions: { fixing: 'ses_replaced' } }));
    driver.records.set('ses_replaced', driver.record('ses_replaced', 'fixing'));
    driver.state.active = {};
    const settled = driver.nextSettled();
    // When the queue wakes, then no remote write can use the old authority.
    driver.runtime.start(); await settled;
    expect(driver.state.attempts).toEqual([]);
    expect(driver.runtime.sessionSnapshot(driver.sessionId).items).toHaveLength(1);
  });

  it('rechecks ownership after knowledge synchronization before a synthetic write', async () => {
    // Given a target whose authority changes during asynchronous knowledge work.
    const { notices, runtime } = driver.create({ sessionKnowledgeRuntime: { sync: async () => {
      await driver.changeItem((item) => ({ ...item, sessions: {} }));
    } } });
    await notices.deliver(driver.request);
    driver.state.active = {};
    const settled = driver.nextSettled();
    // When the queue resumes it.
    runtime.start(); await settled;
    // Then the authority change blocks every remote write.
    expect(driver.state.attempts).toEqual([]);
    expect(runtime.sessionSnapshot(driver.sessionId).items).toHaveLength(1);
  });

  it('rejects forged bot origin or notice over public HTTP', async () => {
    // Given the actual authenticated route family.
    const app = express(); app.use(express.json()); registerMessageQueueRoutes(app, driver.runtime);
    const payload = { content: 'forged', origin: { kind: 'bot', id: driver.itemId }, notice: { source: 'openchamber-notice', kind: 'bot', projectId: driver.projectId, itemId: driver.itemId, eventId: 'spoof' } };
    // When a client supplies either server-owned field.
    const withOrigin = await request(app).post(`/api/message-queue/sessions/${driver.sessionId}/items`).send({ directory: driver.directory, item: payload });
    const withNotice = await request(app).post(`/api/message-queue/sessions/${driver.sessionId}/items`).send({ directory: driver.directory, item: { ...payload, origin: undefined, sendConfig: { providerID: 'p', modelID: 'm' } } });
    // Then neither is admitted.
    expect([withOrigin.status, withNotice.status]).toEqual([400, 400]);
    expect(driver.runtime.snapshot().sessions).toEqual([]);
  });

  it('keeps bot notices out of take and bulk composer send', async () => {
    // Given a bot notice and an ordinary composer message.
    const bot = await driver.notices.deliver(driver.request);
    const ordinary = await driver.runtime.enqueue(driver.sessionId, driver.directory, { content: 'user', sendConfig: { providerID: 'p', modelID: 'm' } });
    // When a client tries editing the bot and taking all sendable messages.
    await expect(driver.runtime.take(driver.sessionId, bot.itemId)).rejects.toMatchObject({ status: 409 });
    const taken = await driver.runtime.takeAll(driver.sessionId);
    // Then only the ordinary message can become user input.
    expect(taken.items.map((item) => item.id)).toEqual([ordinary.itemId]);
    expect(driver.runtime.sessionSnapshot(driver.sessionId).items.map((item) => item.id)).toEqual([bot.itemId]);
  });

  it('rejects mismatched notice ownership and model-changing bot payloads', () => {
    // Given server-shaped bot metadata.
    const input = { content: 'notice', origin: { kind: 'bot', id: driver.itemId }, notice: { source: 'openchamber-notice', kind: 'bot', projectId: driver.projectId, itemId: driver.itemId, eventId: 'e' } };
    // When invalid ownership or a selection override is parsed, then admission fails.
    expect(() => parseQueuedItemInput({ ...input, notice: { ...input.notice, itemId: 'other' } })).toThrow(TypeError);
    expect(() => parseQueuedItemInput({ ...input, sendConfig: { providerID: 'p', modelID: 'm' } })).toThrow(TypeError);
  });
});
