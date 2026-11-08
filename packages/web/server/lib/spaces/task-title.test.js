import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInsideSpaceTaskNaming, sanitizeSpaceTaskTitle, SPACE_TASK_TITLE_EVENT, SPACE_TASK_TITLE_ROUTE } from './task-title.js';
import { createSpaceRecords } from './space-records.js';
import { createSpaceEventSources } from './space-events.js';
import { createWorkNamer } from '../openchamber-sessions/work-naming.js';

const ID = 'a1b2c3d4e5f6';
const OTHER = '0f0f0f0f0f0f';
const directories = [];
const disposers = [];
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'space-title-'));
  directories.push(directory);
  const records = createSpaceRecords({ dataDir: directory });
  records.write(ID, { network: { mode: 'allowlist' }, name: 'Space' });
  return { directory, records };
};
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('space task title ownership', () => {
  it('round-trips old records, agent replacement and user ownership without touching sessions', () => {
    const { directory, records } = fixture();
    expect(records.read(ID).record.taskTitle).toBeNull();
    records.setTaskTitle(ID, { title: 'Agent first', by: 'agent' });
    records.setTaskTitle(ID, { title: 'Agent next', by: 'agent' });
    expect(createSpaceRecords({ dataDir: directory }).read(ID).record.taskTitle).toEqual({ title: 'Agent next', by: 'agent' });
    records.setTaskTitle(ID, { title: 'Mine', by: 'user' });
    expect(records.setTaskTitle(ID, { title: 'Agent again', by: 'agent' })).toEqual({ applied: false, taskTitle: { title: 'Mine', by: 'user' } });
    records.setTaskTitle(ID, { title: 'Mine again', by: 'user' });
    expect(records.read(ID).record.taskTitle).toEqual({ title: 'Mine again', by: 'user' });
  });

  it('sanitizes hostile display text and ignores non-string or empty proposals', () => {
    const { records } = fixture();
    const hostile = ` \u0000\u001b\u202e\u2067${'x'.repeat(150)}\u007f\nSecond line`;
    records.setTaskTitle(ID, { title: hostile, by: 'agent' });
    expect(records.read(ID).record.taskTitle).toEqual({ title: 'x'.repeat(120), by: 'agent' });
    for (const title of [null, 123, {}, '\u0000\u202e  ']) {
      expect(records.setTaskTitle(ID, { title, by: 'agent' }).applied).toBe(false);
    }
    expect(sanitizeSpaceTaskTitle('  Normal task  \nMore')).toBe('Normal task');
  });

  it('keeps the previous record after a failed atomic write', () => {
    const { records } = fixture();
    records.setTaskTitle(ID, { title: 'Before', by: 'agent' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk refused'); });
    expect(() => records.setTaskTitle(ID, { title: 'After', by: 'user' })).toThrow('disk refused');
    expect(records.read(ID).record.taskTitle).toEqual({ title: 'Before', by: 'agent' });
  });

  it('reads older records without a title and drops malformed titles without losing network policy', () => {
    const { directory, records } = fixture();
    const file = path.join(directory, 'spaces', 'records', `${ID}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.taskTitle;
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(records.read(ID).record.taskTitle).toBeNull();
    raw.taskTitle = { title: 'Broken owner', by: 'unknown' };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(records.read(ID)).toMatchObject({ status: 'ok', record: { taskTitle: null, network: { mode: 'allowlist' } } });
  });
});

describe('the server inside a space', () => {
  it('persists and emits its proposal, and keeps the host user name when present', async () => {
    const { directory } = fixture();
    const agentFile = path.join(directory, 'task-title.json');
    const userFile = path.join(directory, 'user-task-title.json');
    const announce = vi.fn();
    const inside = createInsideSpaceTaskNaming({ agentFile, userFile, announce });
    const namer = createWorkNamer({
      getSession: async () => ({ id: 's', title: 'Keep chat title', directory: `/spaces/${ID}/project` }),
      listWorktrees: async () => { throw new Error('Space naming needs no Git'); },
      setWorktreeTaskTitle: vi.fn(),
      nameSpaceTask: inside.name,
      createError: (message) => new Error(message),
    });
    expect(await namer.name({ sessionId: 's', title: 'The task' })).toEqual({ task: 'space', title: 'The task', named: true });
    expect(announce).toHaveBeenCalledWith({ type: SPACE_TASK_TITLE_EVENT, properties: { spaceId: ID, title: 'The task' } });
    expect(await createInsideSpaceTaskNaming({ agentFile, userFile, announce }).read()).toEqual({ title: 'The task' });
    fs.writeFileSync(userFile, JSON.stringify({ title: 'User name' }));
    expect(await namer.name({ sessionId: 's', title: 'Replace it' })).toMatchObject({ named: false, title: 'User name' });
    expect(await inside.read()).toEqual({ title: 'The task' });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('ignores unreadable, oversized and non-plain setting files', async () => {
    const { directory } = fixture();
    const agentFile = path.join(directory, 'agent');
    const userFile = path.join(directory, 'user');
    const inside = createInsideSpaceTaskNaming({ agentFile, userFile, announce: () => {} });
    fs.writeFileSync(userFile, 'x'.repeat(2000));
    expect(await inside.name(`/spaces/${ID}`, 'Task')).toMatchObject({ named: true });
    fs.rmSync(agentFile);
    fs.symlinkSync(userFile, agentFile);
    expect(await inside.read()).toEqual({ title: '' });
    fs.rmSync(agentFile);
    fs.mkdirSync(agentFile);
    expect(await inside.read()).toEqual({ title: '' });
  });
});

it('the host seeds on control connect and accepts only sanitized agent proposals from that space', async () => {
  const { records } = fixture();
  const streams = [];
  const streamFor = new Map();
  const connections = [];
  let seeded = 'Initial task';
  const response = (body, sse = false) => {
    const stream = new PassThrough();
    stream.statusCode = 200;
    stream.headers = { 'content-type': sse ? 'text/event-stream' : 'application/json' };
    if (!sse) stream.end(JSON.stringify(body));
    else streams.push(stream);
    return stream;
  };
  const changed = [];
  const sources = createSpaceEventSources({
    requestInside: async (_id, { path: route }) => {
      connections.push(route);
      if (route === SPACE_TASK_TITLE_ROUTE) return response({ title: seeded, by: 'user' });
      if (route === '/api/sessions/status') return response({ sessions: {} });
      const stream = response(null, true);
      streamFor.set(route, stream);
      return stream;
    },
    index: { acceptSpaceEvent: () => false, forget: () => {} },
    hub: { injectEvent: () => {} },
    broadcastUiEvent: () => {},
    onTaskTitle: (id, title) => { changed.push(records.setTaskTitle(id, { title, by: 'agent' })); },
    stallTimeoutMs: 0,
    stateStallTimeoutMs: 0,
  });
  disposers.push(() => sources.close());
  sources.sync([ID]);
  await vi.waitFor(() => expect(records.read(ID).record.taskTitle).toEqual({ title: 'Initial task', by: 'agent' }));
  const control = streamFor.get('/api/openchamber/events');
  const emit = (spaceId, title) => control.write(`data: ${JSON.stringify({ type: SPACE_TASK_TITLE_EVENT, properties: { spaceId, title, by: 'user' } })}\n\n`);
  emit(ID, `\u001b\u202e${'a'.repeat(130)}\nHidden`);
  await vi.waitFor(() => expect(records.read(ID).record.taskTitle).toEqual({ title: 'a'.repeat(120), by: 'agent' }));
  const count = changed.length;
  emit(OTHER, 'Another space');
  emit(ID, {});
  emit(ID, '\u0000');
  emit(ID, 'Own task');
  await vi.waitFor(() => expect(records.read(ID).record.taskTitle.title).toBe('Own task'));
  expect(changed).toHaveLength(count + 1);
  records.setTaskTitle(ID, { title: 'User wins', by: 'user' });
  emit(ID, 'Agent loses');
  await vi.waitFor(() => expect(changed).toHaveLength(count + 2));
  expect(records.read(ID).record.taskTitle).toEqual({ title: 'User wins', by: 'user' });
  seeded = 'Reconnected agent';
  control.end();
  await vi.waitFor(() => expect(connections.filter((route) => route === SPACE_TASK_TITLE_ROUTE)).toHaveLength(2), { timeout: 2500 });
  expect(records.read(ID).record.taskTitle).toEqual({ title: 'User wins', by: 'user' });
});
