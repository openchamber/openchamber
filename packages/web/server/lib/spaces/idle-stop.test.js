// The idle stop's timer as the server inside a space runs it, on a clock the test moves and a
// setting file the test writes, with the session status as the server's own snapshot gives it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_IDLE_STOP, createIdleStop, readIdleStopSetting } from './idle-stop.js';

const HOUR = 60 * 60 * 1000;
const folders = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A timer that started at hour 0, with the setting written as JSON, or `raw` text written as it is, or no file. */
const timerWith = (setting = { enabled: true, hours: 4 }, { raw = null } = {}) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-idle-'));
  folders.push(folder);
  const settingsPath = path.join(folder, 'idle-stop.json');
  const write = (value) => fs.writeFileSync(settingsPath, JSON.stringify(value));
  if (raw !== null) fs.writeFileSync(settingsPath, raw);
  else if (setting !== null) write(setting);
  const clock = { now: 0 };
  const sessions = {};
  const pending = {};
  const stops = { count: 0 };
  const idleStop = createIdleStop({
    settingsPath,
    readSessionStates: () => sessions,
    readPendingRequests: () => pending,
    stopSpace: async () => { stops.count += 1; },
    now: () => clock.now,
    logger: { log: () => {} },
  });
  /** Moves the clock to that hour and runs one check. */
  const at = (hours) => { clock.now = hours * HOUR; return idleStop.check(); };
  return { at, sessions, pending, stops, write, settingsPath, folder };
};

describe('the idle stop inside a space', () => {
  it('stops the space once the hours of the setting pass with no session working, and not before', async () => {
    const { at, stops } = timerWith({ enabled: true, hours: 4 });
    expect(await at(3.99)).toBe(false);
    expect(await at(4)).toBe(true);
    expect(stops.count).toBe(1);
    // Once is enough: the server is on its way out.
    expect(await at(9)).toBe(false);
    expect(stops.count).toBe(1);
  });

  it('counts a working session as activity and starts counting again when it finishes', async () => {
    const { at, sessions } = timerWith({ enabled: true, hours: 2 });
    sessions.a = { status: 'busy', lastUpdateAt: 0 };
    expect(await at(5)).toBe(false);
    sessions.a = { status: 'retry', lastUpdateAt: 5 * HOUR };
    expect(await at(8)).toBe(false);
    sessions.a = { status: 'idle', lastUpdateAt: 8.5 * HOUR };
    expect(await at(10)).toBe(false);
    expect(await at(10.5)).toBe(true);
  });

  it('counts a session waiting for the user\'s answer as idle, though OpenCode keeps it busy', async () => {
    const { at, sessions, pending } = timerWith({ enabled: true, hours: 2 });
    sessions.q = { status: 'busy', lastUpdateAt: 0 };
    expect(await at(1)).toBe(false);
    pending.q = { permissions: [], forms: [{ id: 'form-1' }] };
    expect(await at(2.5)).toBe(false);
    expect(await at(3)).toBe(true);

    const asked = timerWith({ enabled: true, hours: 2 });
    asked.sessions.p = { status: 'busy', lastUpdateAt: 0 };
    asked.pending.p = { permissions: [{ id: 'per-1' }], forms: [] };
    expect(await asked.at(2)).toBe(true);
  });

  it('counts a turn that began and ended between two checks, at the time it ended', async () => {
    const { at, sessions } = timerWith({ enabled: true, hours: 2 });
    expect(await at(1)).toBe(false);
    sessions.b = { status: 'idle', lastUpdateAt: 1.5 * HOUR };
    expect(await at(3)).toBe(false);
    expect(await at(3.5)).toBe(true);
  });

  it('never stops with the setting off, and takes a changed setting at the next check', async () => {
    const { at, write, stops } = timerWith({ enabled: false, hours: 1 });
    expect(await at(50)).toBe(false);
    write({ enabled: true, hours: 100 });
    expect(await at(60)).toBe(false);
    write({ enabled: true, hours: 60 });
    expect(await at(60)).toBe(true);
    expect(stops.count).toBe(1);
  });

  it.each([
    ['missing', null, null],
    ['not JSON', null, '{'],
    ['out of range', { enabled: true, hours: 0 }, null],
    ['with an unknown field', { enabled: true, hours: 1, stop: 'now' }, null],
    ['far too large', null, `${JSON.stringify({ enabled: true, hours: 1 })}${' '.repeat(2048)}`],
  ])('stops nothing when the setting is %s, because a space never stops on a guess', async (_what, setting, raw) => {
    const { at, stops } = timerWith(setting, { raw });
    expect(await at(500)).toBe(false);
    expect(stops.count).toBe(0);
  });

  it('does not wait on a setting the agent made a FIFO or a folder', async () => {
    const fifo = timerWith(null);
    execFileSync('mkfifo', [fifo.settingsPath]);
    expect(await fifo.at(500)).toBe(false);

    const folder = timerWith(null);
    fs.mkdirSync(folder.settingsPath);
    expect(await folder.at(500)).toBe(false);
  });
});

describe('the idle stop setting on the host', () => {
  it('reads a kept setting, and the default for one that is missing or malformed', () => {
    expect(readIdleStopSetting({ enabled: false, hours: 12 })).toEqual({ enabled: false, hours: 12 });
    for (const value of [undefined, null, {}, { enabled: true, hours: 200 }, 'on']) {
      expect(readIdleStopSetting(value)).toEqual(DEFAULT_IDLE_STOP);
    }
    expect(DEFAULT_IDLE_STOP).toEqual({ enabled: true, hours: 4 });
  });
});
