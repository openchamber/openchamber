import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionWarmingRuntime, DEFAULT_WARMING_MINUTES, WARMING_INTERVAL_MS } from './runtime.js';

const SESSION = 'ses_warm_1';
const DIRECTORY = '/repo';
const MINUTE = 60 * 1000;
const WARMING_DURATION_MS = DEFAULT_WARMING_MINUTES * MINUTE;

const tempDirs = [];
const runtimes = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-session-warming-'));
  tempDirs.push(dir);
  return dir;
};

const status = (type, sessionID = SESSION) => ({ type: 'session.status', properties: { sessionID, status: { type } } });

/**
 * A fake OpenCode: `active` is what `/api/session/active` lists (the running
 * sessions), `answer` what a ping gets back.
 */
const makeRuntime = ({ dataDir = makeDataDir(), answer = () => new Response('{"data":{"text":"OK"}}'), active = {} } = {}) => {
  const events = [];
  const opencode = { active, answer };
  const fetchImpl = vi.fn(async (url) => {
    if (String(url).includes('/api/session/active')) return Response.json({ data: opencode.active });
    return opencode.answer();
  });
  const runtime = createSessionWarmingRuntime({
    dataDir,
    buildOpenCodeUrl: (route) => `http://127.0.0.1:1${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic x' }),
    broadcast: (event) => events.push(event),
    fetchImpl,
  });
  runtimes.push(runtime);
  return { runtime, fetchImpl, events, dataDir, opencode };
};

/**
 * Runs what is due now, including timers armed by what ran: a status read arms
 * the ping. The fake clock fires a timer armed inside another one only once
 * time moves, so each round moves it by a millisecond.
 */
const runDue = async () => {
  for (let round = 0; round < 5; round += 1) await vi.advanceTimersByTimeAsync(1);
};

const pings = (fetchImpl) => fetchImpl.mock.calls.filter(([url]) => String(url).includes(`/api/session/${SESSION}/generate`));

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000_000 });
});

afterEach(async () => {
  // Saves still in flight would write into a directory being removed.
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('session warming runtime', () => {
  it('pings a warmed session every interval after its turn ends, for the default duration', async () => {
    const { runtime, fetchImpl } = makeRuntime();
    runtime.setEnabled(true);
    runtime.processPayload(status('busy'));
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    expect(runtime.snapshot().sessions).toEqual([{ sessionId: SESSION, warmUntil: null }]);

    runtime.processPayload(status('idle'));
    expect(runtime.snapshot().sessions[0].warmUntil).toBe(Date.now() + WARMING_DURATION_MS);

    await vi.advanceTimersByTimeAsync(WARMING_INTERVAL_MS - 1);
    expect(pings(fetchImpl)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(fetchImpl)).toHaveLength(1);
    const [url, init] = pings(fetchImpl)[0];
    expect(new URL(url).searchParams.get('directory')).toBe(DIRECTORY);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).prompt).toMatch(/keep-alive/);

    await vi.advanceTimersByTimeAsync(2 * WARMING_DURATION_MS);
    // Minutes 4, 8, ... 56: the ping at minute 60 would land on the end of the hour.
    expect(pings(fetchImpl)).toHaveLength(WARMING_DURATION_MS / WARMING_INTERVAL_MS - 1);
  });

  it('stops pinging while a turn runs and restarts the hour when it ends', async () => {
    const { runtime, fetchImpl } = makeRuntime();
    runtime.setEnabled(true);
    runtime.processPayload(status('idle'));
    runtime.setSessionWarm(SESSION, DIRECTORY, true);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    runtime.processPayload(status('busy'));
    expect(runtime.snapshot().sessions[0].warmUntil).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(pings(fetchImpl)).toHaveLength(0);

    runtime.processPayload(status('idle'));
    await vi.advanceTimersByTimeAsync(WARMING_INTERVAL_MS);
    expect(pings(fetchImpl)).toHaveLength(1);
  });

  it('times the first ping from the turn that just ended', async () => {
    const { runtime, fetchImpl } = makeRuntime();
    runtime.setEnabled(true);
    runtime.processPayload(status('idle'));
    await vi.advanceTimersByTimeAsync(MINUTE);
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    await vi.advanceTimersByTimeAsync(WARMING_INTERVAL_MS - MINUTE - 1);
    expect(pings(fetchImpl)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(fetchImpl)).toHaveLength(1);
  });

  it('asks OpenCode when it has seen no event for the session: pings at once when idle, waits when running', async () => {
    const idle = makeRuntime();
    idle.runtime.setEnabled(true);
    idle.runtime.setSessionWarm(SESSION, DIRECTORY, true);
    await runDue();
    expect(pings(idle.fetchImpl)).toHaveLength(1);
    expect(idle.runtime.snapshot().sessions[0].warmUntil).toBeGreaterThan(Date.now() + WARMING_DURATION_MS - 10);

    const running = makeRuntime({ active: { [SESSION]: { type: 'busy' } } });
    running.runtime.setEnabled(true);
    running.runtime.setSessionWarm(SESSION, DIRECTORY, true);
    await vi.advanceTimersByTimeAsync(WARMING_DURATION_MS);
    expect(pings(running.fetchImpl)).toHaveLength(0);
    running.runtime.processPayload(status('idle'));
    await vi.advanceTimersByTimeAsync(WARMING_INTERVAL_MS);
    expect(pings(running.fetchImpl)).toHaveLength(1);
  });

  it('settles every warmed session again after the event stream reconnects', async () => {
    const { runtime, fetchImpl, opencode } = makeRuntime();
    runtime.setEnabled(true);
    runtime.processPayload(status('busy'));
    runtime.setSessionWarm(SESSION, DIRECTORY, true);

    // The turn ends while the stream is down; the idle event never arrives.
    runtime.processPayload({ type: 'server.connected', properties: {} });
    await runDue();
    expect(pings(fetchImpl)).toHaveLength(1);
    expect(runtime.snapshot().sessions[0].warmUntil).not.toBeNull();

    // A turn starts unseen in another gap: the pings stop.
    opencode.active = { [SESSION]: { type: 'busy' } };
    runtime.processPayload({ type: 'server.connected', properties: {} });
    await runDue();
    expect(runtime.snapshot().sessions[0].warmUntil).toBeNull();
    await vi.advanceTimersByTimeAsync(WARMING_DURATION_MS);
    expect(pings(fetchImpl)).toHaveLength(1);
  });

  it('keeps pinging on the usual beat after a failed ping', async () => {
    let fail = true;
    const { runtime, fetchImpl } = makeRuntime({ answer: () => new Response('boom', { status: fail ? 503 : 200 }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    runtime.setEnabled(true);
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    await runDue();
    expect(pings(fetchImpl)).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(WARMING_INTERVAL_MS);
    expect(pings(fetchImpl)).toHaveLength(2);
    expect(runtime.snapshot().sessions).toHaveLength(1);
  });

  it('forgets a session OpenCode no longer knows or deleted', async () => {
    const gone = makeRuntime({ answer: () => new Response('{}', { status: 404 }) });
    gone.runtime.setEnabled(true);
    gone.runtime.setSessionWarm(SESSION, DIRECTORY, true);
    await runDue();
    expect(gone.runtime.snapshot().sessions).toEqual([]);
    expect(gone.events.at(-1)).toMatchObject({ type: 'openchamber:session-warming', properties: { sessions: [] } });

    // Deleted mid-turn, so no ping would ever find out.
    const deleted = makeRuntime();
    deleted.runtime.setEnabled(true);
    deleted.runtime.processPayload(status('busy'));
    deleted.runtime.setSessionWarm(SESSION, DIRECTORY, true);
    deleted.runtime.processPayload({ type: 'session.deleted', properties: { sessionID: SESSION } });
    expect(deleted.runtime.snapshot().sessions).toEqual([]);
  });

  it('refuses a session while per-session warming is off, and forgets every session when it turns off', async () => {
    const { runtime, fetchImpl } = makeRuntime();
    expect(runtime.setSessionWarm(SESSION, DIRECTORY, true)).toEqual({ error: 'disabled' });

    runtime.setEnabled(true);
    runtime.processPayload(status('idle'));
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    runtime.setEnabled(false);
    expect(runtime.snapshot()).toMatchObject({ enabled: false, sessions: [] });
    await vi.advanceTimersByTimeAsync(WARMING_DURATION_MS);
    expect(pings(fetchImpl)).toHaveLength(0);
  });

  it('moves running windows by the new step and keeps it across a restart', async () => {
    const { runtime, fetchImpl, dataDir } = makeRuntime();
    runtime.setEnabled(true);
    runtime.processPayload(status('idle'));
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    const started = runtime.snapshot().sessions[0].warmUntil;

    runtime.setMinutes(30);
    expect(runtime.snapshot()).toMatchObject({ minutes: 30, sessions: [{ warmUntil: started - 30 * MINUTE }] });
    await vi.advanceTimersByTimeAsync(2 * WARMING_DURATION_MS);
    // Minutes 4, 8, ... 28.
    expect(pings(fetchImpl)).toHaveLength(7);

    // The window ran out at 30 minutes; three hours brings it back.
    runtime.setMinutes(180);
    await runDue();
    expect(pings(fetchImpl)).toHaveLength(8);

    runtime.processPayload(status('busy'));
    runtime.processPayload(status('idle'));
    expect(runtime.snapshot().sessions[0].warmUntil).toBe(Date.now() + 180 * MINUTE);
    await runtime.stop();

    const restarted = makeRuntime({ dataDir });
    restarted.runtime.start();
    expect(restarted.runtime.snapshot().minutes).toBe(180);
  });

  it('ignores the event stream while per-session warming is off', async () => {
    const { runtime, fetchImpl } = makeRuntime({ active: { [SESSION]: { type: 'busy' } } });
    runtime.processPayload(status('idle'));
    runtime.setEnabled(true);
    // The idle event came before the switch, so it is not taken as the turn's end.
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    await runDue();
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/session/active']);
    expect(runtime.snapshot().sessions[0].warmUntil).toBeNull();
  });

  it('broadcasts a snapshot with a rising revision on every change', () => {
    const { runtime, events } = makeRuntime();
    runtime.setEnabled(true);
    runtime.processPayload(status('busy'));
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    runtime.setSessionWarm(SESSION, DIRECTORY, false);
    const revisions = events.map((event) => event.properties.revision);
    expect(revisions).toHaveLength(3);
    expect(revisions[0]).toBeGreaterThan(Date.now());
    expect(revisions[1]).toBe(revisions[0] + 1);
    expect(revisions[2]).toBe(revisions[1] + 1);
    expect(events.at(-1).properties).toMatchObject({ enabled: true, sessions: [] });
  });

  it('counts the cache warm through the hour and one cache lifetime after it', () => {
    const { runtime } = makeRuntime();
    runtime.setEnabled(true);
    runtime.processPayload(status('idle'));
    runtime.setSessionWarm(SESSION, DIRECTORY, true);
    expect(runtime.isSessionWarm(SESSION, 5 * MINUTE)).toBe(true);
    vi.setSystemTime(Date.now() + WARMING_DURATION_MS + 4 * MINUTE);
    expect(runtime.isSessionWarm(SESSION, 5 * MINUTE)).toBe(true);
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(runtime.isSessionWarm(SESSION, 5 * MINUTE)).toBe(false);
    expect(runtime.isSessionWarm('ses_other', 5 * MINUTE)).toBe(false);
  });

  it('resumes the warmed sessions after a restart once OpenCode says they are idle', async () => {
    const first = makeRuntime();
    first.runtime.setEnabled(true);
    first.runtime.processPayload(status('idle'));
    first.runtime.setSessionWarm(SESSION, DIRECTORY, true);
    await first.runtime.stop();

    const second = makeRuntime({ dataDir: first.dataDir });
    second.runtime.start();
    expect(second.runtime.snapshot()).toMatchObject({ enabled: true, sessions: [{ sessionId: SESSION }] });
    await vi.advanceTimersByTimeAsync(30 * 1000);
    await runDue();
    expect(pings(second.fetchImpl)).toHaveLength(1);

    // Restarted while a turn runs: no ping until it ends.
    const third = makeRuntime({ dataDir: first.dataDir, active: { [SESSION]: { type: 'busy' } } });
    third.runtime.start();
    await vi.advanceTimersByTimeAsync(WARMING_DURATION_MS);
    expect(pings(third.fetchImpl)).toHaveLength(0);
    expect(third.runtime.snapshot().sessions[0].warmUntil).toBeNull();
  });

  it('starts empty and keeps the bytes when the state file is unreadable', () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'session-warming.json'), '{not json');
    const { runtime } = makeRuntime({ dataDir });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    runtime.start();
    expect(runtime.snapshot()).toMatchObject({ enabled: false, sessions: [] });
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('session-warming.json.corrupt-'))).toBe(true);
  });
});
