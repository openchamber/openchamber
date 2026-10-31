import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLocalTracker, LOCAL_TRACKER_DESCRIPTOR } from './tracker.js';
import { readIssue } from './files.js';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-track-')); });
const tracker = () => createLocalTracker({ listProjects: async () => [{ id: 'p1', path: root, label: 'P1' }] });

describe('descriptor', () => {
  it('is frozen and declares create/edit', () => {
    expect(Object.isFrozen(LOCAL_TRACKER_DESCRIPTOR)).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.id).toBe('local');
    expect(LOCAL_TRACKER_DESCRIPTOR.capabilities.create).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.capabilities.edit).toBe(true);
    expect(LOCAL_TRACKER_DESCRIPTOR.authMethods).toEqual([]);
  });
});

describe('auth', () => {
  it('is always connected as Local', async () => {
    const t = await tracker();
    expect(await t.auth.status()).toEqual({ connected: true, account: { id: 'local', name: 'Local', user: null, current: true } });
    await expect(t.auth.start()).rejects.toThrow();
  });
});

describe('list/get/create/edit/updateState', () => {
  it('creates, lists, gets with description and comments, edits, moves state', async () => {
    const t = await tracker();
    const { item } = await t.create({ containerId: 'p1', title: 'First', description: 'Body', priority: 'high', labels: ['bug'] });
    expect(item.identifier).toBe('LOCAL-1');
    expect(item.url).toBe('https://openchamber.local/tracker/local/LOCAL-1');
    expect(item.container).toEqual({ id: 'p1', key: null, name: 'P1' });
    expect(item.priority).toBe('high');
    const listed = await t.list({ state: 'open' });
    expect(listed).toMatchObject({ connected: true, hasMore: false, cursor: null });
    expect(listed.items).toHaveLength(1);
    const detail = await t.get('LOCAL-1');
    expect(detail.item.description).toBe('Body');
    const edited = await t.edit({ id: 'LOCAL-1', title: 'Renamed', labels: ['a', 'b'] });
    expect(edited.item.title).toBe('Renamed');
    expect(edited.item.labels.map((l) => l.name)).toEqual(['a', 'b']);
    const moved = await t.updateState({ id: 'LOCAL-1', stateId: 'done' });
    expect(moved.item.state.category).toBe('done');
    const empty = await t.get('LOCAL-99');
    expect(empty).toEqual({ connected: true, item: null });
  });
  it('stores priority "none" as null in the file, on create and edit', async () => {
    const t = await tracker();
    const priorityOf = (parsed) => {
      const entry = parsed.fields.find(([key]) => key === 'priority');
      return entry ? entry[1] : null;
    };
    const { item } = await t.create({ containerId: 'p1', title: 'Unprioritized', description: null, priority: 'none', labels: [] });
    // The neutral summary maps a null priority back to the `none` filter shape.
    expect(item.priority).toBe('none');
    const dir = path.join(root, '.issues');
    expect(fs.readFileSync(path.join(dir, 'LOCAL-1-unprioritized.md'), 'utf8')).toContain('priority: null');
    expect(priorityOf(readIssue(dir, 'LOCAL-1-unprioritized.md'))).toBeNull();
    // A null priority is stored as the key's absence, the scanner's clear
    // semantics; it still reads back as null.
    await t.edit({ id: 'LOCAL-1', priority: 'none' });
    expect(priorityOf(readIssue(dir, 'LOCAL-1-unprioritized.md'))).toBeNull();
  });
  it('collapses newlines in title and labels to single lines', async () => {
    const t = await tracker();
    const { item } = await t.create({ containerId: 'p1', title: 'Broken\ntitle', description: 'Body', priority: null, labels: ['multi\nline'] });
    expect(item.title).toBe('Broken title');
    expect(item.labels.map((l) => l.name)).toEqual(['multi line']);
    // The file parsed and is served; a newline would have produced a
    // frontmatter line the parser rejects, skipping the file forever.
    const detail = await t.get('LOCAL-1');
    expect(detail.item.title).toBe('Broken title');
    expect(detail.item.labels.map((l) => l.name)).toEqual(['multi line']);
    const edited = await t.edit({ id: 'LOCAL-1', title: 'Renamed\nagain', labels: ['other\nlabel'] });
    expect(edited.item.title).toBe('Renamed again');
    expect(edited.item.labels.map((l) => l.name)).toEqual(['other label']);
  });
  it('returns connected:false-shaped UNSUPPORTED errors as user errors', async () => {
    const t = await tracker();
    await expect(t.create({ containerId: 'unknown', title: 'x' })).rejects.toThrow();
  });
});

describe('preferences and session status', () => {
  let dataDir;
  let previousDataDir;

  // Each test gets its own data dir: `t.preferences.set` persists into
  // `$OPENCHAMBER_DATA_DIR/local-tracker.json`, and one test's write must not
  // flip another test's preference. The package setup's dir is restored after.
  beforeEach(() => {
    previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-track-prefs-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.OPENCHAMBER_DATA_DIR;
    } else {
      process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips the sessionComments preference', async () => {
    const t = await tracker();
    expect(await t.preferences.get()).toEqual({ sessionComments: true });
    await t.preferences.set({ sessionComments: false });
    expect(await t.preferences.get()).toEqual({ sessionComments: false });
  });

  it('posts a started comment and dedupes a repeat of the same kind', async () => {
    const t = await tracker();
    await t.create({ containerId: 'p1', title: 'First', description: 'Body' });

    const result = await t.sessionStatus.post({
      kind: 'started',
      sessionId: 'ses_abc123',
      identifier: 'LOCAL-1',
      sessionOrigin: 'https://app.example.com',
    });
    expect(result).toEqual({ connected: true, posted: true });

    const detail = await t.get('LOCAL-1');
    expect(detail.item.comments).toHaveLength(1);
    expect(detail.item.comments[0].body).toBe('Session started — https://app.example.com');
    expect(detail.item.comments[0].createdAt).toBeTruthy();

    expect(await t.sessionStatus.post({ kind: 'started', sessionId: 'ses_abc123', identifier: 'LOCAL-1' }))
      .toEqual({ connected: true, posted: false, skipped: 'already-posted' });
    expect((await t.get('LOCAL-1')).item.comments).toHaveLength(1);
  });

  it('posts failure for a session the started post linked, without an identifier', async () => {
    const t = await tracker();
    await t.create({ containerId: 'p1', title: 'First', description: 'Body' });
    const longId = 'ses_longer-than-twelve-characters';

    await t.sessionStatus.post({ kind: 'started', sessionId: longId, identifier: 'LOCAL-1', sessionOrigin: 'https://app.example.com' });
    expect(await t.sessionStatus.post({ kind: 'failure', sessionId: longId }))
      .toEqual({ connected: true, posted: true });

    const detail = await t.get('LOCAL-1');
    // The origin the started post carried is recovered for the later event.
    expect(detail.item.comments[1].body).toBe('Session failed — https://app.example.com');
    const fileName = fs.readdirSync(path.join(root, '.issues')).find((name) => name.endsWith('.md'));
    const raw = fs.readFileSync(path.join(root, '.issues', fileName), 'utf8');
    // The heading names the session with a shortened id.
    expect(raw).toContain('· session ses_longer-t');
  });

  it('skips posting without an identifier and when session comments are off', async () => {
    const t = await tracker();
    await t.create({ containerId: 'p1', title: 'First', description: 'Body' });

    expect(await t.sessionStatus.post({ kind: 'started', sessionId: 'ses_1' }))
      .toEqual({ connected: true, posted: false, skipped: 'no-identifier' });

    await t.preferences.set({ sessionComments: false });
    expect(await t.sessionStatus.post({ kind: 'started', sessionId: 'ses_1', identifier: 'LOCAL-1' }))
      .toEqual({ connected: true, posted: false, skipped: 'no-identifier' });
    expect((await t.get('LOCAL-1')).item.comments).toHaveLength(0);
  });

  it('caps in-memory posted-status markers at 500 with FIFO eviction', async () => {
    const t = await tracker();
    await t.create({ containerId: 'p1', title: 'First', description: 'Body' });
    await t.create({ containerId: 'p1', title: 'Second', description: 'Body' });

    const first = 'ses-0000';
    await t.sessionStatus.post({ kind: 'started', sessionId: first, identifier: 'LOCAL-1' });
    expect(await t.sessionStatus.post({ kind: 'started', sessionId: first, identifier: 'LOCAL-1' }))
      .toEqual({ connected: true, posted: false, skipped: 'already-posted' });

    // Push the map past the cap: the oldest marker (the first session) drops.
    for (let i = 1; i <= 500; i += 1) {
      await t.sessionStatus.post({ kind: 'started', sessionId: `ses-${String(i).padStart(4, '0')}`, identifier: 'LOCAL-2' });
    }

    // Evicted: the same post appends a second comment instead of deduping.
    expect(await t.sessionStatus.post({ kind: 'started', sessionId: first, identifier: 'LOCAL-1' }))
      .toEqual({ connected: true, posted: true });
    // Newest marker still present and still dedupes.
    expect(await t.sessionStatus.post({ kind: 'started', sessionId: 'ses-0500', identifier: 'LOCAL-2' }))
      .toEqual({ connected: true, posted: false, skipped: 'already-posted' });
    expect((await t.get('LOCAL-1')).item.comments).toHaveLength(2);
  });

  it('coalesces two concurrent posts of the same session and kind into one comment', async () => {
    const t = await tracker();
    await t.create({ containerId: 'p1', title: 'First', description: 'Body' });

    const [first, second] = await Promise.all([
      t.sessionStatus.post({ kind: 'started', sessionId: 'ses_abc123', identifier: 'LOCAL-1' }),
      t.sessionStatus.post({ kind: 'started', sessionId: 'ses_abc123', identifier: 'LOCAL-1' }),
    ]);
    // Both callers share the one in-flight post, like Linear's inflight map.
    expect(first).toEqual({ connected: true, posted: true });
    expect(second).toEqual({ connected: true, posted: true });
    expect((await t.get('LOCAL-1')).item.comments).toHaveLength(1);
  });

  it('wires a runtime that posts completed through sessionStatus.post', async () => {
    const t = await tracker();
    await t.create({ containerId: 'p1', title: 'First', description: 'Body' });
    await t.sessionStatus.post({ kind: 'started', sessionId: 'ses_1', identifier: 'LOCAL-1' });

    const runtime = t.sessionStatus.createRuntime();
    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    await vi.waitFor(async () => {
      const detail = await t.get('LOCAL-1');
      expect(detail.item.comments.map((comment) => comment.body)).toContain('Session completed');
    });
    runtime.stop();
  });
});

describe('states and matchUrl', () => {
  it('returns the six fixed states with positions', async () => {
    const t = await tracker();
    const { states } = await t.states('p1');
    expect(states.map((s) => s.id)).toEqual(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);
    expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('matches issue URLs like the Linear rules', async () => {
    const t = await tracker();
    expect(t.matchUrl('https://openchamber.local/tracker/local/LOCAL-3')).toBe('LOCAL-3');
    expect(t.matchUrl('http://www.openchamber.local/tracker/local/LOCAL-3/')).toBe('LOCAL-3');
    expect(t.matchUrl('https://evil.example/tracker/local/LOCAL-3')).toBeNull();
  });
});
