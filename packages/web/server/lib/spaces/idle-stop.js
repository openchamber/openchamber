// The idle stop of a space (DESIGN.md, decision 11): the server inside a space stops itself after
// the hours of the user's setting with no session working, and the container stops with it,
// because the server is what the container runs. The timer lives inside, so it works while
// OpenChamber is closed ("Dispatcher, sessions, events", last line). Files stay in the volumes.
//
// The host writes the setting into a file in the space's HOME at every start and whenever the user
// changes it; the server inside reads that file at every check. The agent can change the file, or
// keep a session busy, and so keep its space running: the idle stop saves the user's memory, it
// restricts nothing, and nothing here is a boundary.
//
// This module runs on both sides: the host parses the setting with the schema, and the server
// inside a space runs the timer, only when the space's environment names the file.

import fs from 'node:fs';

import { z } from 'zod';

const IDLE_STOP_MIN_HOURS = 1;
const IDLE_STOP_MAX_HOURS = 168;
export const DEFAULT_IDLE_STOP = Object.freeze({ enabled: true, hours: 4 });

export const idleStopSchema = z.object({
  enabled: z.boolean(),
  hours: z.number().int().min(IDLE_STOP_MIN_HOURS).max(IDLE_STOP_MAX_HOURS),
}).strict();

/** The setting as `settings.json` holds it, or the default when it is missing or not readable. */
export const readIdleStopSetting = (value) => {
  const parsed = idleStopSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_IDLE_STOP };
};

const HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
// The real file is about 30 bytes. The agent owns it and can make it anything, a FIFO among them,
// which a plain read would wait on forever, with the server's event loop stuck behind it.
const MAX_SETTING_BYTES = 1024;
const WORKING = new Set(['busy', 'retry']);

/**
 * `settingsPath` is the file the host writes, `readSessionStates()` the server's own live status
 * by session, `{ [id]: { status, lastUpdateAt } }`, `readPendingRequests()` the permission asks
 * and forms still waiting for an answer by session, and `stopSpace()` ends the server. A session
 * that is working counts as activity now, and every status change counts at the time it came, so
 * a turn that began and ended between two checks is not missed. A session that waits for the
 * user's answer stays busy in OpenCode's status the whole time; it counts as idle (the
 * maintainer's call of 2026-09-28), so its memory is given back when nobody answers. A missing or unreadable file
 * stops nothing: the host writes it at every start, and a space must never stop on a guess.
 */
export function createIdleStop({ settingsPath, readSessionStates, readPendingRequests = () => ({}), stopSpace, now = Date.now, logger = console }) {
  let lastActive = now();
  let stopping = false;

  const readSetting = async () => {
    try {
      const stat = await fs.promises.lstat(settingsPath);
      if (!stat.isFile() || stat.size > MAX_SETTING_BYTES) return null;
      const parsed = idleStopSchema.safeParse(JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const noteActivity = () => {
    const current = now();
    const pending = readPendingRequests();
    const waiting = (sessionId) => (pending[sessionId]?.permissions?.length ?? 0) + (pending[sessionId]?.forms?.length ?? 0) > 0;
    for (const [sessionId, state] of Object.entries(readSessionStates())) {
      if (WORKING.has(state.status) && !waiting(sessionId)) lastActive = current;
      else if (state.lastUpdateAt > lastActive) lastActive = Math.min(state.lastUpdateAt, current);
    }
  };

  /** One check. Resolves true when it stopped the space. */
  const check = async () => {
    if (stopping) return false;
    noteActivity();
    const setting = await readSetting();
    if (!setting?.enabled || now() - lastActive < setting.hours * HOUR_MS) return false;
    stopping = true;
    logger.log?.(`[spaces] no session worked for ${setting.hours} hours; the space stops itself`);
    await stopSpace();
    return true;
  };

  return { check };
}

/** Checks once a minute for the life of the server. Answers the function that ends it. */
export function startIdleStop(options) {
  const idleStop = createIdleStop(options);
  const timer = setInterval(() => {
    idleStop.check().catch((error) => { options.logger?.warn?.(`[spaces] the idle check failed: ${error?.message ?? error}`); });
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
