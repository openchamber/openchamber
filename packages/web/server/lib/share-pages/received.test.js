import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANSWER_AAD,
  DOCUMENT_AAD,
  deriveShareKeys,
  fromBase64Url,
  generateLinkKey,
  openJson,
  sealJson,
  toBase64Url,
} from './crypto.js';
import { parseShareLink, PUBLIC_SHARE_ORIGIN } from './received-link.js';
import { createShareRelayClient, createShareViewerClient } from './relay-client.js';
import { createReceivedPagesRuntime } from './received-runtime.js';
import { createReceivedPageStore } from './received-store.js';
import { registerReceivedPageRoutes } from './routes.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PIN = '482915';

/**
 * A relay share as the author's host makes it (sealed with the sharing side's
 * own crypto), and the relay's public routes over it: the PIN gate, five
 * failures lock it, one answer.
 */
const createAuthorShare = async ({ wantsAnswer = true, document = { v: 1, title: 'Pick a schema', html: '<p>Pick</p>', source: { format: 'ui', text: 'root = Card([])', summary: null } } } = {}) => {
  const linkKey = generateLinkKey();
  const keys = await deriveShareKeys(linkKey, PIN);
  const blob = await sealJson(keys.encKey, document, DOCUMENT_AAD);
  const share = { status: 'open', pinFailures: 0, answer: null, opens: 0 };
  const publicView = () => ({
    status: share.status, kind: wantsAnswer ? 'questionnaire' : 'page', wantsAnswer, expiresAt: Date.now() + 3_600_000, answeredAt: null, attemptsLeft: 5 - share.pinFailures,
  });
  const checkAuth = (auth) => {
    if (share.status !== 'open') return { ok: false, httpStatus: share.status === 'locked' ? 423 : 409, state: publicView() };
    const hash = toBase64Url(crypto.createHash('sha256').update(fromBase64Url(auth)).digest());
    if (hash === keys.authHash) return null;
    share.pinFailures += 1;
    if (share.pinFailures >= 5) share.status = 'locked';
    return { ok: false, httpStatus: share.status === 'locked' ? 423 : 403, state: { ...publicView(), error: 'wrong-pin' } };
  };
  const relay = {
    calls: [],
    status: async (base, id) => {
      relay.calls.push(['status', base, id]);
      return id === SHARE_ID ? { ok: true, httpStatus: 200, state: publicView() } : { ok: false, httpStatus: 404, state: { status: 'missing' } };
    },
    open: async (base, id, auth) => {
      relay.calls.push(['open', base, id]);
      const refused = checkAuth(auth);
      if (refused) return refused;
      share.pinFailures = 0;
      share.opens += 1;
      return { ok: true, httpStatus: 200, state: null, blob };
    },
    answer: async (base, id, auth, sealed) => {
      relay.calls.push(['answer', base, id]);
      const refused = checkAuth(auth);
      if (refused) return refused;
      share.answer = sealed;
      share.status = 'answered';
      return { ok: true, httpStatus: 200, state: publicView() };
    },
  };
  return { link: `${PUBLIC_SHARE_ORIGIN}/p/${SHARE_ID}#${toBase64Url(linkKey)}`, keys, share, relay };
};

const createApp = async ({ relay, enterprise = false, pinned = null, now = Date.now }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-received-'));
  directories.push(dataDir);
  const policy = { enterprise, pinned };
  const events = [];
  const runtime = createReceivedPagesRuntime({
    crypto,
    store: createReceivedPageStore({ fsPromises: fs, path, dataDir }),
    relay,
    isAvailable: () => !policy.enterprise || policy.pinned !== null,
    isEnterpriseMode: () => policy.enterprise,
    allowedBases: async () => (policy.enterprise ? (policy.pinned ? [policy.pinned] : []) : [PUBLIC_SHARE_ORIGIN]),
    broadcast: (event) => events.push(event),
    now,
  });
  const app = express();
  registerReceivedPageRoutes(app, runtime);
  return { app, policy, events, dataDir };
};

const BASE = '/api/openchamber/received-pages';

describe('parseShareLink', () => {
  const key = toBase64Url(generateLinkKey());
  it('reads a link on an allowed relay, keeping a self-hosted path prefix', () => {
    expect(parseShareLink(`https://share.openchamber.dev/p/${SHARE_ID}#${key}`, [PUBLIC_SHARE_ORIGIN]))
      .toEqual({ base: PUBLIC_SHARE_ORIGIN, shareId: SHARE_ID, linkKey: key, host: 'share.openchamber.dev' });
    expect(parseShareLink(`https://relay.acme.test/oc/p/${SHARE_ID}#${key}`, ['https://relay.acme.test/oc']).base).toBe('https://relay.acme.test/oc');
  });

  it('refuses anything that is not a whole share link on an allowed relay', () => {
    const code = (url, bases = [PUBLIC_SHARE_ORIGIN]) => {
      try {
        parseShareLink(url, bases);
        return 'accepted';
      } catch (error) {
        return error.code;
      }
    };
    expect(code(`http://share.openchamber.dev/p/${SHARE_ID}#${key}`)).toBe('invalid_link');
    expect(code(`https://share.openchamber.dev/p/${SHARE_ID}`)).toBe('invalid_link');
    expect(code(`https://share.openchamber.dev/p/${SHARE_ID}#${key.slice(1)}`)).toBe('invalid_link');
    expect(code(`https://share.openchamber.dev/p/short#${key}`)).toBe('invalid_link');
    expect(code(`https://share.openchamber.dev/p/${SHARE_ID}?x=1#${key}`)).toBe('invalid_link');
    expect(code(`https://user@share.openchamber.dev/p/${SHARE_ID}#${key}`)).toBe('invalid_link');
    expect(code(`https://evil.test/p/${SHARE_ID}#${key}`)).toBe('link_not_allowed');
    expect(code(`https://share.openchamber.dev.evil.test/p/${SHARE_ID}#${key}`)).toBe('link_not_allowed');
    expect(code(`https://share.openchamber.dev/p/${SHARE_ID}#${key}`, [])).toBe('link_not_allowed');
  });
});

describe('received page routes', () => {
  it('take a link, open it with the PIN, serve the page, and send one answer the author can read', async () => {
    const author = await createAuthorShare();
    const { app, events, dataDir } = await createApp({ relay: author.relay });

    expect((await request(app).get(`${BASE}/config`).expect(200)).body).toEqual({ available: true, bases: [PUBLIC_SHARE_ORIGIN] });

    const registered = (await request(app).post(BASE).send({ url: author.link }).expect(200)).body;
    // The page has its id before anything waits on the relay.
    expect(author.relay.calls).toEqual([]);
    expect(registered).toMatchObject({ host: 'share.openchamber.dev', opened: false, title: null });
    expect(registered.receivedId).toMatch(/^rp_[0-9a-f]{32}$/);
    const checked = (await request(app).post(`${BASE}/${registered.receivedId}/status`).expect(200)).body;
    expect(checked).toMatchObject({ status: 'open', kind: 'questionnaire', wantsAnswer: true, attemptsLeft: 5 });
    // Nothing secret goes back to the client.
    expect(JSON.stringify(registered)).not.toContain(author.link.split('#')[1]);
    const id = registered.receivedId;
    // The same link again finds the same page.
    expect((await request(app).post(BASE).send({ url: author.link }).expect(200)).body.receivedId).toBe(id);
    await request(app).get(`${BASE}/${id}/document`).expect(404);

    const wrong = (await request(app).post(`${BASE}/${id}/open`).send({ pin: '000000' }).expect(200)).body;
    expect(wrong).toMatchObject({ pinRejected: true, attemptsLeft: 4, status: 'open', opened: false });
    await request(app).post(`${BASE}/${id}/open`).send({ pin: '12' }).expect(400);

    const opened = (await request(app).post(`${BASE}/${id}/open`).send({ pin: PIN }).expect(200)).body;
    expect(opened).toMatchObject({ opened: true, title: 'Pick a schema', source: { format: 'ui', text: 'root = Card([])', summary: null }, answer: null });
    expect(opened.pinRejected).toBeUndefined();
    expect((await request(app).get(`${BASE}/${id}/document`).expect(200)).body).toEqual({ html: '<p>Pick</p>' });

    const answered = (await request(app).post(`${BASE}/${id}/answer`).send({ data: { schema: 'b' }, summary: ' Schema B ' }).expect(200)).body;
    expect(answered).toMatchObject({ status: 'answered', answer: { summary: 'Schema B', data: { schema: 'b' } } });
    // The author's side opens the answer with its own key.
    const sealedAnswer = await openJson(author.keys.encKey, fromBase64Url(author.share.answer), ANSWER_AAD);
    expect(sealedAnswer).toMatchObject({ v: 1, data: { schema: 'b' }, summary: 'Schema B' });

    const again = await request(app).post(`${BASE}/${id}/answer`).send({ data: 1, summary: 'Twice' }).expect(409);
    expect(again.body.error).toMatch(/already sent/);
    expect(author.relay.calls.filter(([name]) => name === 'answer')).toHaveLength(1);

    // On disk, owner-only; the PIN is not kept, the link key is.
    const file = path.join(dataDir, 'received-pages', `${id}.json`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const stored = await fs.readFile(file, 'utf8');
    expect(stored).not.toContain(PIN);
    expect(events.every((event) => event.type === 'openchamber:received-page' && event.properties.receivedId === id)).toBe(true);
  });

  it('report a locked share after five wrong PINs and keep it locked for the right one', async () => {
    const author = await createAuthorShare();
    const { app } = await createApp({ relay: author.relay });
    const id = (await request(app).post(BASE).send({ url: author.link })).body.receivedId;
    await request(app).post(`${BASE}/${id}/status`);
    for (let attempt = 0; attempt < 4; attempt += 1) await request(app).post(`${BASE}/${id}/open`).send({ pin: '111111' });
    const fifth = (await request(app).post(`${BASE}/${id}/open`).send({ pin: '111111' }).expect(200)).body;
    expect(fifth).toMatchObject({ status: 'locked', pinRejected: true, attemptsLeft: 0 });
    const right = (await request(app).post(`${BASE}/${id}/open`).send({ pin: PIN }).expect(200)).body;
    expect(right).toMatchObject({ status: 'locked', opened: false, pinRejected: false });
  });

  it('refuse an answer to a read-only page and refuse links from other relays', async () => {
    const author = await createAuthorShare({ wantsAnswer: false, document: { v: 1, title: 'Report', html: '<h1>Q3</h1>' } });
    const { app } = await createApp({ relay: author.relay });
    const id = (await request(app).post(BASE).send({ url: author.link })).body.receivedId;
    await request(app).post(`${BASE}/${id}/status`);
    const opened = (await request(app).post(`${BASE}/${id}/open`).send({ pin: PIN })).body;
    expect(opened).toMatchObject({ wantsAnswer: false, source: null, title: 'Report' });
    await request(app).post(`${BASE}/${id}/answer`).send({ data: 1, summary: 'x' }).expect(409);

    const foreign = await request(app).post(BASE).send({ url: author.link.replace(PUBLIC_SHARE_ORIGIN, 'https://evil.test') }).expect(400);
    expect(foreign.body.code).toBe('link_not_allowed');
    await request(app).get(`${BASE}/rp_${'0'.repeat(32)}`).expect(404);
  });

  it('in enterprise mode without a pinned relay, report nothing and refuse every route', async () => {
    const author = await createAuthorShare();
    const { app, policy } = await createApp({ relay: author.relay });
    const id = (await request(app).post(BASE).send({ url: author.link })).body.receivedId;
    policy.enterprise = true;
    expect((await request(app).get(`${BASE}/config`).expect(200)).body).toEqual({ available: false, bases: [] });
    for (const call of [
      request(app).post(BASE).send({ url: author.link }),
      request(app).get(`${BASE}/${id}`),
      request(app).post(`${BASE}/${id}/open`).send({ pin: PIN }),
      request(app).get(`${BASE}/${id}/document`),
      request(app).get(BASE),
    ]) {
      const refused = await call.expect(403);
      expect(refused.body.code).toBe('enterprise_mode');
    }
    expect(author.relay.calls.filter(([name]) => name === 'open')).toHaveLength(0);

    // A pinned relay brings it back, for links on that relay only.
    policy.pinned = 'https://relay.acme.test';
    expect((await request(app).get(`${BASE}/config`).expect(200)).body).toEqual({ available: true, bases: ['https://relay.acme.test'] });
    expect((await request(app).get(`${BASE}/${id}`).expect(403)).body.code).toBe('enterprise_mode');
    expect((await request(app).post(BASE).send({ url: author.link }).expect(403)).body.code).toBe('enterprise_mode');
  });

  it('list every received page newest first, with what a row shows and nothing of the page itself', async () => {
    const author = await createAuthorShare();
    let clock = 1_000;
    const { app } = await createApp({ relay: author.relay, now: () => clock });
    const first = (await request(app).post(BASE).send({ url: author.link })).body.receivedId;
    await request(app).post(`${BASE}/${first}/status`);
    await request(app).post(`${BASE}/${first}/open`).send({ pin: PIN });
    await request(app).post(`${BASE}/${first}/answer`).send({ data: { secret: 'value' }, summary: 'B' });
    clock = 2_000;
    const otherLink = author.link.replace(SHARE_ID, 'ZyXwVuTsRqPoNmLkJiHgFe');
    const second = (await request(app).post(BASE).send({ url: otherLink })).body.receivedId;

    const { pages } = (await request(app).get(BASE).expect(200)).body;
    expect(pages.map((page) => page.receivedId)).toEqual([second, first]);
    expect(pages[1]).toMatchObject({ title: 'Pick a schema', status: 'answered', answer: { summary: 'B' }, createdAt: 1_000 });
    expect(JSON.stringify(pages)).not.toContain('secret');
    expect(pages[1].source).toBeUndefined();
    expect(pages[0]).toMatchObject({ host: 'share.openchamber.dev', opened: false, title: null });
  });

  it('keep a pasted link and its last known state when the relay cannot be read', async () => {
    const author = await createAuthorShare();
    const { app } = await createApp({ relay: author.relay });
    const id = (await request(app).post(BASE).send({ url: author.link }).expect(200)).body.receivedId;
    await request(app).post(`${BASE}/${id}/status`).expect(200);
    author.relay.status = async () => { throw new Error('The relay answered 503'); };
    expect((await request(app).post(`${BASE}/${id}/status`).expect(502)).body.error).toMatch(/503/);
    expect((await request(app).get(`${BASE}/${id}`).expect(200)).body).toMatchObject({ status: 'open', kind: 'questionnaire' });
  });
});

describe('the recipient\'s relay client', () => {
  const respond = (status, body, contentType = 'application/json') => async () => new Response(body, { status, headers: { 'content-type': contentType } });
  const json = (value) => JSON.stringify(value);

  it('reads a share\'s state and refuses anything that is not one', async () => {
    const ok = createShareViewerClient({ fetchImpl: respond(200, json({ status: 'locked', attemptsLeft: 0 })) });
    expect(await ok.status('https://r.test', SHARE_ID)).toMatchObject({ ok: true, state: { status: 'locked' } });
    const missing = createShareViewerClient({ fetchImpl: respond(404, json({ status: 'missing' })) });
    expect((await missing.status('https://r.test', SHARE_ID)).state.status).toBe('missing');
    // A proxy's error page, an outage, or a body without a state is a failure to read the relay.
    for (const fetchImpl of [respond(503, '<html>down</html>', 'text/html'), respond(404, '<html>nope</html>', 'text/html'), respond(200, json({ hello: 1 }))]) {
      await expect(createShareViewerClient({ fetchImpl }).status('https://r.test', SHARE_ID)).rejects.toThrow(/relay answered/);
    }
    await expect(createShareViewerClient({ fetchImpl: respond(500, json({ status: 'open' })) }).answer('https://r.test', SHARE_ID, 'a', 'b')).rejects.toThrow(/500/);
  });

  it('never follows a redirect, on either side', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(init.redirect); return new Response(JSON.stringify({ status: 'open' }), { status: 200 }); };
    const viewer = createShareViewerClient({ fetchImpl });
    await viewer.status('https://r.test', SHARE_ID);
    await viewer.answer('https://r.test', SHARE_ID, 'a', 'b');
    const signer = { serverId: 's', pk: 'p', bodyHash: () => 'h', sign: () => 'x' };
    const host = createShareRelayClient({ getSigner: async () => signer, fetchImpl: async (url, init) => { seen.push(init.redirect); return new Response(JSON.stringify({ states: [] }), { status: 200 }); } });
    await host.states('https://r.test', ['id1']);
    expect(seen).toEqual(['error', 'error', 'error']);
  });
});
