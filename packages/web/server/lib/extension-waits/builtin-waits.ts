import { z } from 'zod';

import { waitArgsSchema } from '@openchamber/sdk/schemas';

import {
  SCRIPT,
  SCRIPT_SOURCE,
  checkScriptAutomation,
  createScriptAutomation,
  failureStatusOf,
  listScriptAutomations,
  openCodeRefusal,
  parseScriptArgs,
  readOpenCodeVersion,
  removeScriptAutomation,
  scriptsUnsupported,
  supportsScripts,
} from './script-wait.js';
import type { ScriptAutomationRequest } from './script-wait.js';
import type { StartWaitInput, Wait } from './runtime.js';
import type { WaitArgs } from './wake-message.js';

export const TIMER_SOURCE = 'timer';
const TIMER_MINUTES_MAX = 24 * 60;
export const BUILT_IN_EXTENSION = 'OpenChamber';
const SCRIPT_POLL_MAX_MS = 60_000;
const VERSION_TTL_MS = 60_000;
const ORPHAN_GRACE_MS = 5 * 60_000;

export const TIMER = {
  source: TIMER_SOURCE,
  extension: BUILT_IN_EXTENSION,
  title: 'Timer',
  description: 'Wakes the session once the given number of minutes has passed',
  params: { minutes: { type: 'number', description: `Whole minutes, 1 to ${TIMER_MINUTES_MAX}`, required: true } },
} as const;

export const isBuiltIn = (wait: Pick<Wait, 'guestId'>) => wait.guestId === null;
export const isTimer = (wait: Pick<Wait, 'guestId' | 'type'>) => isBuiltIn(wait) && wait.type === TIMER_SOURCE;
export const isScript = (wait: Pick<Wait, 'guestId' | 'type'>) => isBuiltIn(wait) && wait.type === SCRIPT_SOURCE;

const scriptStateSchema = z.object({ automationID: z.string().min(1) });
const scriptAutomationOf = (wait: Pick<Wait, 'state'>) => scriptStateSchema.safeParse(wait.state).data?.automationID;

const minutesText = (minutes: WaitArgs[string]) => (minutes === 1 ? '1 minute' : `${minutes} minutes`);
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });
const failureText = (cause: Parameters<typeof String>[0]) => (cause instanceof Error ? cause.message : String(cause));

const readArgs = (rawArgs: StartWaitInput['args']): StartWaitInput['args'] => {
  const text = z.string().safeParse(rawArgs);
  if (!text.success) return rawArgs;
  try {
    return z.json().parse(JSON.parse(text.data));
  } catch {
    return rawArgs;
  }
};
const timerMinutesSchema = z.number().int().min(1).max(TIMER_MINUTES_MAX);

export type PreparedWait = { record: Wait; next: string; discard?: () => Promise<void> };

type StartInput = { sessionID: string; directory: StartWaitInput['directory']; rawArgs: StartWaitInput['args'] };

type CollectTimer = ReturnType<typeof setTimeout>;

interface BuiltInWaitsOptions {
  request: ScriptAutomationRequest;
  owner: string;
  storedWaits: () => Wait[];
  isSessionArchived: (sessionID: string) => boolean | Promise<boolean>;
  dropWait: (wait: Wait) => Promise<void>;
  timers: { setTimeout: (callback: () => void, delay: number) => CollectTimer; clearTimeout: (timer: CollectTimer) => void };
  now: () => number;
  createId: () => string;
  isCurrent: (wait: Wait) => boolean;
  endWait: (wait: Wait, reason: string) => void;
  failingReason: string;
  failureLimitMs: number;
  warn: (...args: Parameters<typeof console.warn>) => void;
}

export function createBuiltInWaits({ request, owner, storedWaits, isSessionArchived, dropWait, timers, now, createId, isCurrent, endWait, failingReason, failureLimitMs, warn }: BuiltInWaitsOptions) {
  let version: { value: string | null; at: number } | null = null;
  let collectTimer: CollectTimer | null = null;
  let collecting = false;

  const openCodeVersion = async () => {
    if (version && now() - version.at < VERSION_TTL_MS) return version.value;
    const value = await readOpenCodeVersion(request).catch(() => null);
    version = value === null ? null : { value, at: now() };
    return value;
  };

  const sources = async () => {
    const builtIns: Array<typeof TIMER | typeof SCRIPT> = [TIMER];
    if (supportsScripts(await openCodeVersion())) builtIns.push(SCRIPT);
    return builtIns.map((source) => ({ ...source, params: { ...source.params } }));
  };

  const scriptPollMs = (wait: Pick<Wait, 'args'>) => Math.min(Number(wait.args.minutes) * 60_000, SCRIPT_POLL_MAX_MS);

  const recordOf = (input: StartInput, fields: Pick<Wait, 'type' | 'title' | 'label' | 'args' | 'state'> & { firstCheckInMs: number }): Wait => {
    const startedAt = now();
    const { firstCheckInMs, ...rest } = fields;
    return {
      id: `wait_${createId()}`,
      sessionID: input.sessionID,
      directory: input.directory || null,
      guestId: null,
      extensionName: null,
      ...rest,
      startedAt,
      nextCheckAt: startedAt + firstCheckInMs,
      failingSince: null,
      wake: null,
    };
  };

  const prepareTimer = async (input: StartInput): Promise<PreparedWait> => {
    const parsed = waitArgsSchema(TIMER.params).safeParse(readArgs(input.rawArgs) ?? {});
    if (!parsed.success) throw httpError(parsed.error.issues[0]?.message ?? 'args do not match the wait\'s params', 400);
    const checked = timerMinutesSchema.safeParse(parsed.data.minutes);
    if (!checked.success) throw httpError(`minutes must be a whole number from 1 to ${TIMER_MINUTES_MAX}`, 400);
    const minutes = checked.data;
    return {
      record: recordOf(input, { type: TIMER_SOURCE, title: TIMER.title, label: `${minutes} min`, args: parsed.data, state: null, firstCheckInMs: minutes * 60_000 }),
      next: `A message arrives in this session in ${minutesText(minutes)}. One wake ends the wait: call wait.start again to keep waiting. End your turn now if you have nothing else to do; never wait with a sleep loop.`,
    };
  };

  const prepareScript = async (input: StartInput): Promise<PreparedWait> => {
    const parsed = parseScriptArgs(readArgs(input.rawArgs));
    if (!parsed.ok) throw httpError(parsed.error, 400);
    const { args } = parsed;
    const current = await openCodeVersion();
    if (!supportsScripts(current)) throw httpError(scriptsUnsupported(current), 400);
    let automationID;
    try {
      automationID = await createScriptAutomation(request, { sessionID: input.sessionID, args, owner });
    } catch (error) {
      throw httpError(`OpenCode refused the script: ${openCodeRefusal(error)}`, failureStatusOf(error) === 403 ? 403 : 400);
    }
    return {
      record: recordOf(input, { type: SCRIPT_SOURCE, title: SCRIPT.title, label: `every ${minutesText(args.minutes)}`, args, state: { automationID }, firstCheckInMs: scriptPollMs({ args }) }),
      next: `The script runs every ${minutesText(args.minutes)} for up to ${args.hours} h, and a message arrives in this session when it returns a wake. One wake ends the wait. End your turn now if you have nothing else to do; never wait with a sleep loop.`,
      discard: () => removeScriptAutomation(request, automationID).catch((error) => {
        collectLater();
        throw error;
      }),
    };
  };

  const prepare = (name: string, input: StartInput) => {
    if (name === TIMER_SOURCE) return () => prepareTimer(input);
    if (name === SCRIPT_SOURCE) return () => prepareScript(input);
    return undefined;
  };

  const checkScript = async (wait: Wait) => {
    const automationID = scriptAutomationOf(wait);
    let check;
    try {
      if (!automationID) throw new Error('the wait does not name its automation');
      check = await checkScriptAutomation(request, automationID);
    } catch (error) {
      warn(`[extension-waits] a script wait could not be checked: ${failureText(error)}`);
      wait.failingSince ??= now();
      if (now() - wait.failingSince >= failureLimitMs) endWait(wait, failingReason);
      else wait.nextCheckAt = now() + scriptPollMs(wait);
      return;
    }
    wait.failingSince = null;
    if (!isCurrent(wait) || wait.wake) return;
    if (check.kind === 'fired') wait.wake = { outcome: 'fired', summary: check.summary, messageID: null };
    else if (check.kind === 'ended') endWait(wait, check.reason);
    else wait.nextCheckAt = now() + scriptPollMs(wait);
  };

  const markTimers = (due: Wait[]) => {
    for (const wait of due) {
      if (isTimer(wait)) wait.wake = { outcome: 'fired', summary: `${minutesText(wait.args.minutes)} passed.`, messageID: null };
    }
  };

  const checkScripts = async (due: Wait[]) => {
    const scripts = due.filter(isScript);
    const archived = await Promise.all(scripts.map((wait) => Promise.resolve(isSessionArchived(wait.sessionID)).catch(() => false)));
    await Promise.all(scripts.map((wait, index) => (archived[index] === true ? dropWait(wait).catch(() => undefined) : checkScript(wait))));
  };

  const release = (ended: Wait[]) => {
    for (const automationID of ended.filter(isScript).map(scriptAutomationOf)) {
      if (!automationID) continue;
      void removeScriptAutomation(request, automationID).catch((error) => {
        collectLater();
        warn(`[extension-waits] the script automation ${automationID} could not be deleted yet: ${failureText(error)}`);
      });
    }
  };

  const collectLater = (delayMs = ORPHAN_GRACE_MS) => {
    if (collectTimer) return;
    collectTimer = timers.setTimeout(() => {
      collectTimer = null;
      void collectOrphans();
    }, delayMs);
    collectTimer.unref?.();
  };

  async function collectOrphans() {
    if (collecting) return;
    collecting = true;
    try {
      const current = await openCodeVersion();
      if (!supportsScripts(current)) {
        if (current === null) collectLater();
        return;
      }
      const known = new Set(storedWaits().filter(isScript).map(scriptAutomationOf));
      let young = false;
      for (const automation of await listScriptAutomations(request, owner)) {
        if (known.has(automation.id)) continue;
        if (now() - automation.time.created < ORPHAN_GRACE_MS) young = true;
        else await removeScriptAutomation(request, automation.id);
      }
      if (young) collectLater();
    } catch (error) {
      collectLater();
      warn(`[extension-waits] script automations without a wait could not be cleared: ${failureText(error)}`);
    } finally {
      collecting = false;
    }
  }

  const stop = () => {
    if (collectTimer) timers.clearTimeout(collectTimer);
    collectTimer = null;
  };

  return { sources, prepare, markTimers, checkScripts, release, collectOrphans, stop };
}
