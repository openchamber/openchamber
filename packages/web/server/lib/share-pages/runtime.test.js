import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANSWER_AAD, DOCUMENT_AAD, deriveShareKeys, fromBase64Url, openJson, sealJson, toBase64Url } from './crypto.js';
import { createSharePagesRuntime, parseShareRequest } from './runtime.js';
import { createSharePageStore, shareGroupId } from './store.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const BASE = 'https://relay.test';

/** A relay that keeps shares in memory, with the browser side of the crypto for tests. */
const createFakeRelay = () => {
  const shares = new Map();
  let counter = 0;
  const failNext = new Set();
  const relay = {
    create: vi.fn(async (base, blob, meta) => {
      if (failNext.has('create')) {
        failNext.delete('create');
        throw Object.assign(new Error('The relay answered 503'), { status: 503 });
      }
      counter += 1;
      const id = `share${String(counter).padStart(17, '0')}`;
      shares.set(id, { blob, meta, status: 'open', opens: [], answer: null, answeredAt: null, closed: false });
      return { id, url: `${base}/p/${id}`, expiresAt: meta.expiresAt };
    }),
    states: vi.fn(async (_base, ids) => ids.map((id) => {
      const share = shares.get(id);
      return share ? { id, ...share, blob: undefined, meta: undefined } : { id, status: 'missing' };
    })),
    // Like the relay: the reply carries the answer the close deleted.
    close: vi.fn(async (_base, id) => {
      const share = shares.get(id);
      if (!share) throw Object.assign(new Error('404'), { status: 404 });
      const deleted = share.closed ? null : share.answer;
      share.closed = true;
      share.answer = null;
      if (share.answeredAt === null) share.status = 'cancelled';
      return { id, status: share.status, closed: true, answer: deleted, answeredAt: share.answeredAt };
    }),
  };
  /** What the viewer does: PIN + key from the link, open, answer. */
  const answer = async (link, pin, value) => {
    const [url, key] = link.split('#');
    const id = url.split('/p/')[1];
    const share = shares.get(id);
    const keys = await deriveShareKeys(fromBase64Url(key), pin);
    expect(keys.authHash).toBe(share.meta.authHash);
    const document = await openJson(keys.encKey, share.blob, DOCUMENT_AAD);
    share.opens.push(1000);
    share.answer = toBase64Url(await sealJson(keys.encKey, { v: 1, submittedAt: 5, ...value }, ANSWER_AAD));
    share.answeredAt = 2000;
    share.status = 'answered';
    return document;
  };
  return { relay, shares, answer, failNext };
};

const createHarness = async ({ dataDir, relayFake = createFakeRelay(), available = () => true, allowed = () => true, postSynthetic = vi.fn(async () => {}), failSaves = () => false, onAnswerDelivered = vi.fn() } = {}) => {
  const directory = dataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-share-pages-'));
  if (!dataDir) directories.push(directory);
  const diskStore = createSharePageStore({ fsPromises: fs, path, dataDir: directory });
  const store = {
    ...diskStore,
    save: async (group) => {
      if (failSaves()) throw new Error('disk full');
      return diskStore.save(group);
    },
  };
  const broadcast = vi.fn();
  let clock = new Date(2026, 10, 13, 17, 0).getTime();
  const runtime = createSharePagesRuntime({
    crypto,
    store,
    relay: relayFake.relay,
    postSynthetic,
    onAnswerDelivered,
    broadcast,
    isAvailable: available,
    isRelayBaseAllowed: allowed,
    resolveRelayBase: async () => BASE,
    now: () => clock,
    sleep: async () => {},
    setIntervalImpl: () => ({ unref() {} }),
    logger: { warn: () => {} },
  });
  return { runtime, store, broadcast, postSynthetic, onAnswerDelivered, relayFake, directory, advance: (ms) => { clock += ms; } };
};

const share = (input) => parseShareRequest({ recipients: ['Юля', 'Denis'], ...input });

describe('parseShareRequest', () => {
  it('reads the documented shape and JSON text of it', () => {
    expect(parseShareRequest('{"recipients":[" Yulia "],"expectAnswer":false}')).toEqual({
      recipients: ['Yulia'], summary: null, expectAnswer: false, expiresInHours: undefined,
    });
  });

  it('refuses no one, too many, a name twice, and a bad expiry', () => {
    expect(() => parseShareRequest({ recipients: [] })).toThrow(/recipients is required/);
    expect(() => parseShareRequest({ recipients: Array.from({ length: 11 }, (_, index) => `P${index}`) })).toThrow(/limit is 10/);
    expect(() => parseShareRequest({ recipients: ['Yulia', 'yulia'] })).toThrow(/twice/);
    expect(() => parseShareRequest({ recipients: ['Y'], expiresInHours: 0 })).toThrow(/at least 1/);
    expect(() => parseShareRequest({ recipients: ['x'.repeat(61)] })).toThrow(/longer than 60/);
  });
});

describe('share pages runtime', () => {
  it('uploads one sealed page per recipient, delivers an answer into the session, and closes it', async () => {
    const harness = await createHarness();
    const { runtime, relayFake, postSynthetic, broadcast } = harness;

    const created = await runtime.createGroup({ sessionId: 'ses_1', callId: 'call_1', title: 'Schema', share: share() });
    // Fri 17:00 + two working days.
    expect(created).toEqual({ recipients: ['Юля', 'Denis'], expiresAt: new Date(2026, 10, 17, 17, 0).getTime() });
    const preparing = await runtime.getGroup('ses_1', 'call_1');
    expect(preparing.documentState).toBe('preparing');
    expect(preparing.recipients.map(({ status, link, pin }) => ({ status, link, pin }))).toEqual([
      { status: 'preparing', link: null, pin: null },
      { status: 'preparing', link: null, pin: null },
    ]);

    const uploaded = await runtime.uploadDocument('ses_1', 'call_1', { html: '<p>Pick</p>', title: 'Schema' });
    expect(uploaded.documentState).toBe('ready');
    expect(uploaded.recipients.every(({ status, link, pin }) => status === 'open' && link.includes('#') && /^\d{6}$/.test(pin))).toBe(true);
    expect(relayFake.relay.create.mock.calls[0][2]).toMatchObject({ kind: 'questionnaire', wantsAnswer: true, expiresAt: created.expiresAt });
    expect(await runtime.preview('ses_1', 'call_1')).toEqual({ html: '<p>Pick</p>' });
    await expect(runtime.uploadDocument('ses_1', 'call_1', { html: '<p>Pick</p>' })).rejects.toMatchObject({ statusCode: 409 });

    const [yulia] = uploaded.recipients;
    expect(await relayFake.answer(yulia.link, yulia.pin, { data: { pick: 'B' }, summary: 'Picked B' })).toEqual({ v: 1, title: 'Schema', html: '<p>Pick</p>' });

    await runtime.poll();

    expect(postSynthetic).toHaveBeenCalledTimes(1);
    const [sessionId, message] = postSynthetic.mock.calls[0];
    expect(sessionId).toBe('ses_1');
    expect(message).toMatchObject({
      delivery: 'steer',
      resume: true,
      metadata: { source: 'openchamber-share-answer', callId: 'call_1', recipientId: 'r1', label: 'Юля', title: 'Schema' },
    });
    expect(message.id).toMatch(/^msg_/);
    expect(message.text).toContain('<openchamber-share-answer from="Юля" verified="false" page="Schema">');
    expect(message.text).toContain('Summary: "Picked B"');
    expect(message.text).toContain('Data: {"pick":"B"}');
    expect(message.text).not.toContain(yulia.pin);

    const after = await runtime.getGroup('ses_1', 'call_1');
    expect(after.recipients[0]).toMatchObject({ status: 'answered', answeredAt: 2000, answerSummary: 'Picked B', opens: [1000] });
    expect(after.recipients[1].status).toBe('open');
    expect(relayFake.relay.close).toHaveBeenCalledWith(BASE, yulia.link.split('/p/')[1].split('#')[0]);
    expect(broadcast).toHaveBeenCalledWith({ type: 'openchamber:share-page', properties: { sessionId: 'ses_1', callId: 'call_1' } });

    // Delivered once: the next poll sends nothing again.
    await runtime.poll();
    expect(postSynthetic).toHaveBeenCalledTimes(1);
  });

  it('keeps going past one failed upload and retries it on the next document post', async () => {
    const { runtime, relayFake } = await createHarness();
    await runtime.createGroup({ sessionId: 'ses_1', callId: 'call_2', title: 'T', share: share({ expectAnswer: false }) });
    relayFake.failNext.add('create');

    const first = await runtime.uploadDocument('ses_1', 'call_2', { html: '<p>A</p>' });
    expect(first.recipients.map(({ status }) => status)).toEqual(['failed', 'open']);
    expect(first.recipients[0].error).toContain('503');

    const second = await runtime.uploadDocument('ses_1', 'call_2', { html: '<p>ignored, the first page is kept</p>' });
    expect(second.recipients.map(({ status }) => status)).toEqual(['open', 'open']);
    expect(relayFake.relay.create.mock.calls.at(-1)[2]).toMatchObject({ kind: 'page', wantsAnswer: false });
    expect(await runtime.preview('ses_1', 'call_2')).toEqual({ html: '<p>A</p>' });
  });

  it('seals the page source with the document, for every recipient including a retried one', async () => {
    const { runtime, relayFake } = await createHarness();
    await runtime.createGroup({ sessionId: 'ses_1', callId: 'call_src', title: 'T', share: share() });
    relayFake.failNext.add('create');
    const source = { format: 'html', text: '<h1>Q3</h1>', summary: 'Q3 numbers' };
    const first = await runtime.uploadDocument('ses_1', 'call_src', { html: '<p>A</p>', source: { ...source, extra: 1 } });
    const second = await runtime.uploadDocument('ses_1', 'call_src', { html: '<p>B</p>' });
    for (const recipient of [first.recipients[1], second.recipients[0]]) {
      const [url, key] = recipient.link.split('#');
      const keys = await deriveShareKeys(fromBase64Url(key), recipient.pin);
      const document = await openJson(keys.encKey, relayFake.shares.get(url.split('/p/')[1]).blob, DOCUMENT_AAD);
      expect(document).toEqual({ v: 1, title: 'T', html: '<p>A</p>', source });
    }
  });

  it('withdraws a link, and keeps an answer that already arrived instead', async () => {
    const { runtime, relayFake } = await createHarness();
    await runtime.createGroup({ sessionId: 'ses_1', callId: 'call_3', title: 'T', share: share() });
    const { recipients } = await runtime.uploadDocument('ses_1', 'call_3', { html: '<p>A</p>' });

    const cancelled = await runtime.cancelRecipient('ses_1', 'call_3', 'r2');
    expect(cancelled.recipients[1].status).toBe('cancelled');

    await relayFake.answer(recipients[0].link, recipients[0].pin, { data: 1, summary: 'yes' });
    await expect(runtime.cancelRecipient('ses_1', 'call_3', 'r1')).rejects.toMatchObject({ statusCode: 409 });
    expect((await runtime.getGroup('ses_1', 'call_3')).recipients[0].status).toBe('answered');
  });

  it('delivers an answer it decrypted before a restart', async () => {
    const failing = vi.fn(async () => { throw Object.assign(new Error('down'), { status: 503 }); });
    const first = await createHarness({ postSynthetic: failing });
    await first.runtime.createGroup({ sessionId: 'ses_1', callId: 'call_4', title: 'T', share: share({ recipients: ['Yulia'] }) });
    const { recipients } = await first.runtime.uploadDocument('ses_1', 'call_4', { html: '<p>A</p>' });
    await first.relayFake.answer(recipients[0].link, recipients[0].pin, { data: null, summary: 'ok' });
    await first.runtime.poll();
    expect(failing).toHaveBeenCalledTimes(4);
    const messageId = failing.mock.calls[0][1].id;

    // Another process on the same data dir; OpenCode answers now, with 409 for an id it admitted.
    const postSynthetic = vi.fn(async () => { throw Object.assign(new Error('dup'), { status: 409 }); });
    const second = await createHarness({ dataDir: first.directory, relayFake: first.relayFake, postSynthetic });
    await second.runtime.start();
    expect(postSynthetic).toHaveBeenCalledTimes(1);
    expect(postSynthetic.mock.calls[0][1].id).toBe(messageId);
    const group = await second.store.get(shareGroupId(crypto, 'ses_1', 'call_4'));
    expect(group.recipients[0]).toMatchObject({ delivery: { delivered: true }, relayClosed: true });
  });

  it('refuses to share while unavailable, and does not reach a relay it may not use', async () => {
    const off = await createHarness({ available: () => false });
    await expect(off.runtime.createGroup({ sessionId: 's', callId: 'c', title: 'T', share: share() }))
      .rejects.toMatchObject({ statusCode: 403, code: 'enterprise_mode' });

    let allowed = true;
    const harness = await createHarness({ allowed: () => allowed });
    await harness.runtime.createGroup({ sessionId: 's', callId: 'c', title: 'T', share: share() });
    allowed = false;
    await expect(harness.runtime.uploadDocument('s', 'c', { html: '<p>A</p>' })).rejects.toMatchObject({ statusCode: 403, code: 'enterprise_mode' });
    await harness.runtime.poll();
    expect(harness.relayFake.relay.create).not.toHaveBeenCalled();
    expect(harness.relayFake.relay.states).not.toHaveBeenCalled();
  });

  it('marks a share the relay reports expired, and an upload too late as expired', async () => {
    const { runtime, relayFake, advance } = await createHarness();
    await runtime.createGroup({ sessionId: 's', callId: 'late', title: 'T', share: share({ recipients: ['A'], expiresInHours: 1 }) });
    advance(58 * 60_000);
    await expect(runtime.uploadDocument('s', 'late', { html: '<p>A</p>' })).rejects.toMatchObject({ statusCode: 409 });
    expect((await runtime.getGroup('s', 'late')).recipients[0].status).toBe('expired');

    await runtime.createGroup({ sessionId: 's', callId: 'ok', title: 'T', share: share({ recipients: ['A'] }) });
    await runtime.uploadDocument('s', 'ok', { html: '<p>A</p>' });
    [...relayFake.shares.values()].at(-1).status = 'expired';
    await runtime.poll();
    expect((await runtime.getGroup('s', 'ok')).recipients[0].status).toBe('expired');
  });
});

describe('share pages runtime races', () => {
  it('keeps the delivery a cancel minted when a poll read the share before that cancel took the answer', async () => {
    const harness = await createHarness();
    const { runtime, relayFake, postSynthetic } = harness;
    await runtime.createGroup({ sessionId: 's', callId: 'race', title: 'T', share: share({ recipients: ['A'] }) });
    const { recipients } = await runtime.uploadDocument('s', 'race', { html: '<p>A</p>' });
    await relayFake.answer(recipients[0].link, recipients[0].pin, { data: 1, summary: 'yes' });

    // The poll's state read resolves only after the cancel recorded the answer.
    let releaseStates;
    const statesGate = new Promise((resolve) => { releaseStates = resolve; });
    const realStates = relayFake.relay.states.getMockImplementation();
    relayFake.relay.states.mockImplementationOnce(async (...args) => {
      const states = await realStates(...args);
      await statesGate;
      return states;
    });
    const polling = runtime.poll();
    await expect(runtime.cancelRecipient('s', 'race', 'r1')).rejects.toMatchObject({ statusCode: 409 });
    const minted = (await harness.store.get(shareGroupId(crypto, 's', 'race'))).recipients[0].delivery.messageId;
    releaseStates();
    await polling;
    await runtime.poll();

    expect(postSynthetic).toHaveBeenCalledTimes(1);
    // A retry after a lost response must reuse the id OpenCode may already hold.
    expect(postSynthetic.mock.calls[0][1].id).toBe(minted);
  });
});

describe('share pages runtime review fixes', () => {
  it('keeps an answer submitted between the cancel\'s read and its close, and delivers it', async () => {
    const { runtime, relayFake, postSynthetic } = await createHarness();
    await runtime.createGroup({ sessionId: 's', callId: 'late-answer', title: 'T', share: share({ recipients: ['A'] }) });
    const { recipients } = await runtime.uploadDocument('s', 'late-answer', { html: '<p>A</p>' });
    const realStates = relayFake.relay.states.getMockImplementation();
    relayFake.relay.states.mockImplementationOnce(async (...args) => {
      const states = await realStates(...args);
      await relayFake.answer(recipients[0].link, recipients[0].pin, { data: { pick: 'B' }, summary: 'Picked B' });
      return states;
    });

    await expect(runtime.cancelRecipient('s', 'late-answer', 'r1')).rejects.toMatchObject({ statusCode: 409 });
    expect((await runtime.getGroup('s', 'late-answer')).recipients[0]).toMatchObject({ status: 'answered', answerSummary: 'Picked B' });
    await runtime.poll();
    expect(postSynthetic).toHaveBeenCalledTimes(1);
    expect(postSynthetic.mock.calls[0][1].text).toContain('Data: {"pick":"B"}');
  });

  it('delivers nothing while the answer and its message id are not on disk', async () => {
    let failing = false;
    const harness = await createHarness({ failSaves: () => failing });
    const { runtime, relayFake, postSynthetic, store } = harness;
    await runtime.createGroup({ sessionId: 's', callId: 'disk', title: 'T', share: share({ recipients: ['A'] }) });
    const { recipients } = await runtime.uploadDocument('s', 'disk', { html: '<p>A</p>' });
    await relayFake.answer(recipients[0].link, recipients[0].pin, { data: 1, summary: 'yes' });

    failing = true;
    await runtime.poll();
    expect(postSynthetic).not.toHaveBeenCalled();
    expect(relayFake.relay.close).not.toHaveBeenCalled();
    const inMemory = (await store.get(shareGroupId(crypto, 's', 'disk'))).recipients[0];
    expect(inMemory).toMatchObject({ status: 'open', answer: null, delivery: null });

    failing = false;
    await runtime.poll();
    expect(postSynthetic).toHaveBeenCalledTimes(1);
    const onDisk = JSON.parse(await fs.readFile(path.join(harness.directory, 'share-pages', `${shareGroupId(crypto, 's', 'disk')}.json`), 'utf8'));
    expect(postSynthetic.mock.calls[0][1].id).toBe(onDisk.recipients[0].delivery.messageId);
  });

  it('finishes uploads a restart interrupted, from the stored document', async () => {
    const first = await createHarness();
    await first.runtime.createGroup({ sessionId: 's', callId: 'resume', title: 'T', share: share() });
    // What a crash right after the document was stored leaves on disk.
    const group = await first.store.get(shareGroupId(crypto, 's', 'resume'));
    await first.store.saveDocument(group.id, '<p>stored</p>');
    group.documentState = 'ready';
    await first.store.save(group);

    const second = await createHarness({ dataDir: first.directory });
    await second.runtime.start();
    const view = await second.runtime.getGroup('s', 'resume');
    expect(view.recipients.map(({ status }) => status)).toEqual(['open', 'open']);
    expect(await second.relayFake.answer(view.recipients[0].link, view.recipients[0].pin, { data: null, summary: '' })).toMatchObject({ html: '<p>stored</p>' });
  });

  it('refuses every card route once sharing is unavailable or its relay no longer allowed', async () => {
    let available = true;
    let allowed = true;
    const { runtime } = await createHarness({ available: () => available, allowed: () => allowed });
    await runtime.createGroup({ sessionId: 's', callId: 'ent', title: 'T', share: share() });
    await runtime.uploadDocument('s', 'ent', { html: '<p>A</p>' });
    for (const flip of [() => { available = false; }, () => { available = true; allowed = false; }]) {
      flip();
      for (const call of [
        () => runtime.getGroup('s', 'ent'),
        () => runtime.preview('s', 'ent'),
        () => runtime.cancelRecipient('s', 'ent', 'r1'),
        () => runtime.uploadDocument('s', 'ent', { html: '<p>A</p>' }),
      ]) {
        await expect(call()).rejects.toMatchObject({ statusCode: 403, code: 'enterprise_mode' });
      }
    }
  });
});

describe('share pages runtime notification hook', () => {
  it('reports each answer OpenCode admitted once, and none for a 409 replay', async () => {
    const first = await createHarness();
    await first.runtime.createGroup({ sessionId: 's', callId: 'n', title: 'Schema', share: share({ recipients: ['A'] }) });
    const { recipients } = await first.runtime.uploadDocument('s', 'n', { html: '<p>A</p>' });
    await first.relayFake.answer(recipients[0].link, recipients[0].pin, { data: 1, summary: 'yes' });
    await first.runtime.poll();
    await first.runtime.poll();
    expect(first.onAnswerDelivered).toHaveBeenCalledTimes(1);
    expect(first.onAnswerDelivered).toHaveBeenCalledWith({ sessionId: 's', label: 'A', title: 'Schema', summary: 'yes' });

    const replay = await createHarness({ postSynthetic: vi.fn(async () => { throw Object.assign(new Error('dup'), { status: 409 }); }) });
    await replay.runtime.createGroup({ sessionId: 's', callId: 'n', title: 'Schema', share: share({ recipients: ['A'] }) });
    const second = await replay.runtime.uploadDocument('s', 'n', { html: '<p>A</p>' });
    await replay.relayFake.answer(second.recipients[0].link, second.recipients[0].pin, { data: 1, summary: 'yes' });
    await replay.runtime.poll();
    expect(replay.onAnswerDelivered).not.toHaveBeenCalled();
  });
});
