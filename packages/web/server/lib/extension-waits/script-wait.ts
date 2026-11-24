import { z } from 'zod';

import { WAIT_SUMMARY_MAX } from '@openchamber/sdk';

import { isOpenCodeOlderThan } from '../opencode/compatibility.js';
import type { JsonValue } from '../shared/json-values.js';

export const SCRIPT_SOURCE = 'script';
export const SCRIPT_CODE_MAX = 8_000;
const SCRIPT_AUTOMATION_NAME = 'OpenChamber script wait';
export const scriptAutomationName = (owner: string) => `${SCRIPT_AUTOMATION_NAME} ${owner}`;
const SCRIPT_MINIMUM_OPENCODE = '2.4.0';
const MINUTES_MAX = 24 * 60;
const HOURS_DEFAULT = 24;
const HOURS_MAX = 7 * 24;
const REASON_MAX = 500;

export const SCRIPT = {
  source: SCRIPT_SOURCE,
  extension: 'OpenChamber',
  title: 'Script',
  description: [
    'Runs a Code Mode script every few minutes without a model and wakes the session when it says so.',
    'The script may call tools.<ns>.<tool>(...) and fetch, and reads `state`: what it returned as { state } last time, null at first.',
    'Return a non-empty string, or { wake: "..." }, to wake this session with that text; return nothing, or { state }, to keep waiting.',
    'A run that throws ends the wait with its error, so catch the errors you expect. Tools whose permission asks the user cannot run in a script.',
  ].join(' '),
  params: {
    code: { type: 'string', description: `The script, at most ${SCRIPT_CODE_MAX} characters`, required: true },
    minutes: { type: 'number', description: `Whole minutes between runs, 1 to ${MINUTES_MAX}`, required: true },
    hours: { type: 'number', description: `How long to keep checking, 1 to ${HOURS_MAX} whole hours; ${HOURS_DEFAULT} when left out` },
  },
} as const;

const wholeNumber = (name: string, min: number, max: number) => z.number({ error: `${name} must be a number` })
  .int(`${name} must be a whole number from ${min} to ${max}`)
  .min(min, `${name} must be a whole number from ${min} to ${max}`)
  .max(max, `${name} must be a whole number from ${min} to ${max}`);

const scriptArgsSchema = z.strictObject({
  code: z.string({ error: 'code is required' }).trim().min(1, 'code is required')
    .max(SCRIPT_CODE_MAX, `code is longer than ${SCRIPT_CODE_MAX} characters`),
  minutes: wholeNumber('minutes', 1, MINUTES_MAX),
  hours: wholeNumber('hours', 1, HOURS_MAX).optional(),
}, { error: (issue) => (issue.code === 'unrecognized_keys' ? `Unknown argument "${issue.keys[0]}"; a script takes code, minutes and hours` : 'args must be an object') });

export type ScriptArgs = { code: string; minutes: number; hours: number };
export type ScriptArgsInput = Parameters<typeof scriptArgsSchema.safeParse>[0];

export const parseScriptArgs = (given: ScriptArgsInput): { ok: true; args: ScriptArgs } | { ok: false; error: string } => {
  const parsed = scriptArgsSchema.safeParse(given ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'args do not match the script\'s params' };
  return { ok: true, args: { ...parsed.data, hours: parsed.data.hours ?? HOURS_DEFAULT } };
};

export const wrapScript = (code: string) => [
  'let __openchamberResult;',
  'try {',
  '  __openchamberResult = await (async (state) => {',
  code,
  '  })(state?.s ?? null);',
  '} catch (__openchamberError) {',
  '  return { done: true, state: { s: state?.s ?? null, error: String(__openchamberError?.stack ?? __openchamberError).slice(0, 2000) || "it threw an empty value" } };',
  '}',
  'const __openchamberState = __openchamberResult !== null && typeof __openchamberResult === "object" && "state" in __openchamberResult ? __openchamberResult.state : (state?.s ?? null);',
  'const __openchamberWake = typeof __openchamberResult === "string" ? __openchamberResult : __openchamberResult?.wake;',
  'if (typeof __openchamberWake === "string" && __openchamberWake.trim()) return { done: true, state: { s: __openchamberState, wake: __openchamberWake.trim() } };',
  'return { state: { s: __openchamberState } };',
].join('\n');

export type ScriptAutomationRequest = (fetchPath: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: object }) => Promise<JsonValue | undefined>;

const createdSchema = z.object({ id: z.string().min(1) });
const automationSchema = z.object({
  status: z.string(),
  lastOutcome: z.string().optional(),
  lastOutput: z.string().optional(),
  state: z.object({ wake: z.string().optional(), error: z.string().optional() }).passthrough().nullish().catch(null),
});
const listedSchema = z.array(z.object({ id: z.string().min(1), name: z.string(), time: z.object({ created: z.number() }) }).passthrough());
const infoSchema = z.object({ version: z.string() });
const errorBodySchema = z.object({ message: z.string().min(1) });
const failureSchema = z.object({ status: z.number().optional(), detail: z.string().optional(), message: z.string().optional() });

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const openCodeRefusal = (cause: Parameters<typeof failureSchema.safeParse>[0]) => {
  const failure = failureSchema.safeParse(cause);
  if (!failure.success) return String(cause);
  let body: JsonValue | undefined;
  try {
    body = z.json().parse(JSON.parse(failure.data.detail ?? ''));
  } catch {
    body = undefined;
  }
  return errorBodySchema.safeParse(body).data?.message ?? failure.data.message ?? String(cause);
};

export const failureStatusOf = (cause: Parameters<typeof failureSchema.safeParse>[0]) => failureSchema.safeParse(cause).data?.status;

export const readOpenCodeVersion = async (request: ScriptAutomationRequest) => infoSchema.safeParse(await request('/api/info', { method: 'GET' })).data?.version ?? null;

export const supportsScripts = (version: string | null) => version !== null && !isOpenCodeOlderThan(version, SCRIPT_MINIMUM_OPENCODE);

export const scriptsUnsupported = (version: string | null) => (version
  ? `Script waits need OpenCode ${SCRIPT_MINIMUM_OPENCODE} or newer; this one is ${version}`
  : 'Script waits need OpenCode, which could not be asked its version');

export const createScriptAutomation = async (request: ScriptAutomationRequest, input: { sessionID: string; args: ScriptArgs; owner: string }) => {
  const created = await request('/api/experimental/automation', {
    method: 'POST',
    body: {
      sessionID: input.sessionID,
      name: scriptAutomationName(input.owner),
      trigger: { type: 'every', every: input.args.minutes === 1 ? '1 minute' : `${input.args.minutes} minutes` },
      action: { type: 'code', code: wrapScript(input.args.code) },
      expires: input.args.hours === 1 ? 'in 1 hour' : `in ${input.args.hours} hours`,
    },
  });
  const parsed = createdSchema.safeParse(created);
  if (!parsed.success) throw new Error('OpenCode created the script\'s automation but did not name it');
  return parsed.data.id;
};

export type ScriptCheck = { kind: 'waiting' } | { kind: 'fired'; summary: string } | { kind: 'ended'; reason: string };

const failedReason = (text: string | undefined) => clip(`the script failed: ${text?.trim() || 'it gave no error text'}`, REASON_MAX);

export const checkScriptAutomation = async (request: ScriptAutomationRequest, automationID: string): Promise<ScriptCheck> => {
  let answer;
  try {
    answer = await request(`/api/experimental/automation/${encodeURIComponent(automationID)}`, { method: 'GET' });
  } catch (error) {
    if (failureStatusOf(error) === 404) return { kind: 'ended', reason: 'its automation was deleted in OpenCode' };
    throw error;
  }
  const automation = automationSchema.safeParse(answer);
  if (!automation.success) throw new Error('OpenCode answered the script\'s automation with something OpenChamber could not read');
  const { status, lastOutcome, lastOutput, state } = automation.data;
  if (state?.error !== undefined) return { kind: 'ended', reason: failedReason(state.error) };
  if (lastOutcome === 'failed') return { kind: 'ended', reason: failedReason(lastOutput) };
  if (status !== 'done') return { kind: 'waiting' };
  const wake = state?.wake?.trim();
  return wake ? { kind: 'fired', summary: clip(wake, WAIT_SUMMARY_MAX) } : { kind: 'ended', reason: 'its time ran out without the script waking the session' };
};

export const removeScriptAutomation = async (request: ScriptAutomationRequest, automationID: string) => {
  try {
    await request(`/api/experimental/automation/${encodeURIComponent(automationID)}`, { method: 'DELETE' });
  } catch (error) {
    if (failureStatusOf(error) !== 404) throw error;
  }
};

export const listScriptAutomations = async (request: ScriptAutomationRequest, owner: string) => {
  const listed = listedSchema.safeParse(await request('/api/experimental/automation', { method: 'GET' }));
  if (!listed.success) throw new Error('OpenCode listed its automations in a shape OpenChamber could not read');
  return listed.data.filter((automation) => automation.name === scriptAutomationName(owner));
};
