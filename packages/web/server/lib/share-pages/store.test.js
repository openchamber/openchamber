import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSharePageStore, shareGroupId } from './store.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const recipient = (overrides) => ({
  recipientId: 'r1', label: 'A', pin: '123456', linkKey: 'k', shareId: 'id', url: 'u', status: 'expired', opens: [],
  answeredAt: null, answer: null, delivery: null, relayClosed: true, error: null, ...overrides,
});
const group = (index, recipientOverrides) => ({
  version: 1, id: shareGroupId(crypto, 's', `c${index}`), sessionId: 's', callId: `c${index}`, title: 'T', kind: 'page',
  expectAnswer: false, summary: null, createdAt: index, expiresAt: index + 1, relayBase: 'https://relay.test',
  documentState: 'ready', recipients: [recipient(recipientOverrides)],
});

describe('share page store retention', () => {
  it('keeps at most 100 groups, dropping the oldest finished ones with their page copies and never one in play', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-share-store-'));
    directories.push(dataDir);
    const store = createSharePageStore({ fsPromises: fs, path, dataDir });
    // The two oldest are still in play: one open, one answered but not delivered yet.
    await store.save(group(0, { status: 'open', relayClosed: false }));
    await store.save(group(1, { status: 'answered', answer: { summary: 's', data: null, submittedAt: null }, delivery: { messageId: 'm', delivered: false } }));
    for (let index = 2; index < 103; index += 1) {
      await store.saveDocument(group(index).id, '<p>page</p>');
      await store.save(group(index));
    }

    const kept = (await store.list()).map(({ callId }) => callId);
    expect(kept).toHaveLength(100);
    expect(kept).toEqual(expect.arrayContaining(['c0', 'c1', 'c102']));
    expect(kept).not.toContain('c2');
    expect(kept).not.toContain('c4');
    expect(await store.readDocument(group(2).id)).toBeNull();
    expect(await store.readDocument(group(5).id)).toBe('<p>page</p>');
    const files = await fs.readdir(path.join(dataDir, 'share-pages'));
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(100);
    expect(files.filter((name) => name.endsWith('.html'))).toHaveLength(98);
  });
});
