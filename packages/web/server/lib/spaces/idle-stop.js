
import { z } from 'zod';

import { readSpaceSettingFile } from './space-setting-file.js';

const IDLE_STOP_MIN_HOURS = 1;
const IDLE_STOP_MAX_HOURS = 168;
export const DEFAULT_IDLE_STOP = Object.freeze({ enabled: true, hours: 4 });

export const idleStopSchema = z.object({
  enabled: z.boolean(),
  hours: z.number().int().min(IDLE_STOP_MIN_HOURS).max(IDLE_STOP_MAX_HOURS),
}).strict();

export const readIdleStopSetting = (value) => {
  const parsed = idleStopSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_IDLE_STOP };
};

const HOUR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const WORKING = new Set(['busy', 'retry']);

export function createIdleStop({ settingsPath, readSessionStates, readPendingRequests = () => ({}), stopSpace, now = Date.now, logger = console }) {
  let lastActive = now();
  let stopping = false;

  const noteActivity = () => {
    const current = now();
    const pending = readPendingRequests();
    const waiting = (sessionId) => (pending[sessionId]?.permissions?.length ?? 0)
      + (pending[sessionId]?.forms?.length ?? 0)
      + (pending[sessionId]?.pages?.length ?? 0) > 0;
    for (const [sessionId, state] of Object.entries(readSessionStates())) {
      if (WORKING.has(state.status) && !waiting(sessionId)) lastActive = current;
      else if (state.lastUpdateAt > lastActive) lastActive = Math.min(state.lastUpdateAt, current);
    }
  };

  const check = async () => {
    if (stopping) return false;
    noteActivity();
    const setting = await readSpaceSettingFile(settingsPath, idleStopSchema);
    if (!setting?.enabled || now() - lastActive < setting.hours * HOUR_MS) return false;
    stopping = true;
    logger.log?.(`[spaces] no session worked for ${setting.hours} hours; the space stops itself`);
    await stopSpace();
    return true;
  };

  return { check };
}

export function startIdleStop(options) {
  const idleStop = createIdleStop(options);
  const timer = setInterval(() => {
    idleStop.check().catch((error) => { options.logger?.warn?.(`[spaces] the idle check failed: ${error?.message ?? error}`); });
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
