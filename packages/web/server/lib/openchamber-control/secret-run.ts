import { isRecord, isString } from '../shared/guards.js';
import { runCommand } from '../spaces/run-command.js';
import { OpenChamberControlError, controlErrorFields } from './error.js';
import type { PageWaitOptions, createPageAnswers } from './render-page.js';
import type { ActionContext } from './contracts.js';

export interface SecretRunInput {
  program?: unknown;
  args?: unknown;
  reason?: unknown;
  inputs?: unknown;
  timeoutMs?: unknown;
}

interface SecretValues {
  [env: string]: string;
}

interface SubmittedSecrets {
  values: SecretValues;
  remember: string[];
  save: string[];
  saveGlobally: string[];
}

type SavedScope = 'project' | 'global';

export interface StoredSecrets {
  projectId: string | null;
  project: SecretValues;
  global: SecretValues;
}

export interface SavedSecretStore {
  read: (directory: string) => Promise<StoredSecrets>;
  write: (scope: SavedScope, projectId: string | null, patch: Record<string, string | null>) => Promise<void>;
  remove: (projectId: string | null, expected: { project: SecretValues; global: SecretValues }) => Promise<void>;
}

interface SecretSlot {
  kind: 'run' | 'forget';
  fields: string[];
  reused: string[];
  savedValues: SecretValues;
  savedScopes: Record<string, SavedScope>;
  savedInBoth: string[];
  projectId: string | null;
  canSaveGlobally: boolean;
  deliver: (answer: SubmittedSecrets) => void;
}

interface SecretSubmission {
  answer: SubmittedSecrets | null;
}

interface SecretCommandResult {
  outcome: 'exited' | 'timeout' | 'not-started' | 'killed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface SecretRunResult {
  answer: { status: 'ran'; outcome: SecretCommandResult['outcome']; exitCode: number | null };
  stdout: string;
  stderr: string;
  remembered: string[];
  note: string;
  saved?: string[];
  notSaved?: string[];
  truncated?: { stdout: boolean; stderr: boolean };
  error?: string;
}

export interface SecretRunContext extends ActionContext {
  sessionId?: string | null;
  callId?: string | null;
  authorized?: boolean;
}

type CommandRunner = (program: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  killTree: boolean;
  keepTail: boolean;
  maxOutputBytes: number;
}) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SecretRunsOptions {
  waits: Pick<ReturnType<typeof createPageAnswers>, 'wait'>;
  hasUnreadChat: (sessionId: string) => Promise<boolean>;
  leases?: ReturnType<typeof createSecretLeases> | undefined;
  saved?: SavedSecretStore | null | undefined;
  run?: CommandRunner | undefined;
}

interface SecretSubmissionInput {
  values?: unknown;
  remember?: unknown;
  save?: unknown;
  saveGlobally?: unknown;
  saved?: unknown;
}

interface SubmittedValuesInput {
  [env: string]: SecretSubmissionInput['values'];
}

type SettleSecret = (sessionId: string, callId: string, summary: string, data: null) => void;

export const SECRET_RUN_MAX_INPUTS = 8;
const SECRET_RUN_MAX_REASON_LENGTH = 1000;
export const SECRET_RUN_MAX_LABEL_LENGTH = 120;
export const SECRET_RUN_MAX_PLACEHOLDER_LENGTH = 80;
export const SECRET_RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const SECRET_RUN_MAX_TIMEOUT_MS = 600_000;
export const SECRET_LEASE_MS = 10 * 60_000;
const SECRET_MAX_VALUE_LENGTH = 16_000;
const CAPTURE_BYTES = 1024 * 1024;
const OUTPUT_LIMIT = 32_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const RAN_NOTE = "The command ran once, with the secrets in its environment. In stdout and stderr every secret value is replaced by [secret:NAME]. Fix a failing command and call secret.run again; the env names in remembered are reused without asking the user while they last. The ones in saved are kept for this project or for all projects: a later secret.run shows them on the card, and the user confirms them with one click.";
const DECLINED_NOTE = "The user declined to give the secrets, so the command did not run. Continue without it or say what it blocks; ask again only if they want to.";
const CHAT_SENT_EARLIER_NOTE = "The card did not wait and the command did not run: the user had already written in the chat before it appeared, and that message follows this result. Continue from that message; call again only if it still fits.";
const SAVED_CHANGED_NOTE = "The command did not run: a saved secret was forgotten or changed while the card waited. Call secret.run again; the card asks the user for what is no longer saved.";
const KEPT_NOTE = "The user kept the saved secrets; the ones this chat remembered are forgotten. Ask to forget the saved ones again only if the user asks.";
const FORGET_CHAT_SENT_EARLIER_NOTE = "The card did not wait and the saved secrets are kept: the user had already written in the chat before it appeared, and that message follows this result. Continue from that message.";

export function secretRunCommandLine(program: string, args: readonly string[]) {
  const hidden = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x61c
    || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff;
  const visible = (value: string) => Array.from(value, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return hidden(code) ? `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}` : char;
  }).join('');
  const word = (value: string) => (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(value) ? value : `'${visible(value).replaceAll("'", "'\\''")}'`);
  return [program, ...args].map(word).join(' ');
}

export function secretRunCommand(input: Pick<SecretRunInput, 'program' | 'args'> | null | undefined) {
  const isText = (value: unknown): value is string => Object.prototype.toString.call(value) === '[object String]';
  const program = isText(input?.program) ? input.program.trim() : '';
  if (!program) return { error: 'program is required: the executable to run, by name on PATH or by absolute path. It runs without a shell; for a script pass program "sh" (or "bash") with args ["-c", "<script>"]' };
  const args = input?.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || !args.every(isText)) return { error: 'args must be an array of strings' };
  if (args.length > 64) return { error: `args has ${args.length} entries; the limit is 64` };
  const length = program.length + args.reduce((total, arg) => total + arg.length + 1, 0);
  if (length > 32000) return { error: `The command is ${length} characters; the limit is 32000. Put a long script in a file and run that` };
  return { program, args };
}

const isText = (value: unknown): value is string => isString(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isValues = (value: unknown): value is SubmittedValuesInput => isRecord(value);
const readText = (value: SecretRunInput[keyof SecretRunInput]) => (isText(value) ? value.trim() : '');

const refuse = (message: string) => new OpenChamberControlError(message, 400);

const normalizeSecretRun = (input: SecretRunInput = {}) => {
  const command = secretRunCommand(input);
  if (command.program === undefined) throw refuse(command.error);
  const reason = readText(input.reason);
  if (!reason) throw refuse('reason is required: in the user\'s language, what the command does with the secrets');
  if (reason.length > SECRET_RUN_MAX_REASON_LENGTH) throw refuse(`reason is ${reason.length} characters; the limit is ${SECRET_RUN_MAX_REASON_LENGTH}`);
  if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
    throw refuse('inputs is required: one { env, label } per secret the command reads from its environment');
  }
  if (input.inputs.length > SECRET_RUN_MAX_INPUTS) throw refuse(`inputs has ${input.inputs.length} entries; the limit is ${SECRET_RUN_MAX_INPUTS}`);
  const seen = new Set();
  const inputs = input.inputs.map((entry, index) => {
    const env = readText(entry?.env);
    const label = readText(entry?.label);
    const placeholder = readText(entry?.placeholder);
    if (!ENV_NAME.test(env)) throw refuse(`inputs[${index}].env must be an environment variable name such as API_TOKEN`);
    if (seen.has(env)) throw refuse(`inputs[${index}].env ${env} appears twice`);
    seen.add(env);
    if (!label) throw refuse(`inputs[${index}].label is required: what the secret is, shown above its field`);
    if (label.length > SECRET_RUN_MAX_LABEL_LENGTH) throw refuse(`inputs[${index}].label is ${label.length} characters; the limit is ${SECRET_RUN_MAX_LABEL_LENGTH}`);
    if (placeholder.length > SECRET_RUN_MAX_PLACEHOLDER_LENGTH) throw refuse(`inputs[${index}].placeholder is ${placeholder.length} characters; the limit is ${SECRET_RUN_MAX_PLACEHOLDER_LENGTH}`);
    return { env, label, placeholder };
  });
  let timeoutMs = SECRET_RUN_DEFAULT_TIMEOUT_MS;
  if (input.timeoutMs !== undefined) {
    if (!isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SECRET_RUN_MAX_TIMEOUT_MS) {
      throw refuse(`timeoutMs must be a whole number of milliseconds from 1 to ${SECRET_RUN_MAX_TIMEOUT_MS}`);
    }
    timeoutMs = input.timeoutMs;
  }
  return { ...command, reason, inputs, timeoutMs };
};

export const createSecretLeases = ({ now = Date.now, leaseMs = SECRET_LEASE_MS }: { now?: () => number; leaseMs?: number } = {}) => {
  const leases = new Map<string, { value: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  const key = (sessionId: string, env: string) => `${sessionId}\u0000${env}`;

  const drop = (entryKey: string) => {
    const lease = leases.get(entryKey);
    if (!lease) return;
    clearTimeout(lease.timer);
    leases.delete(entryKey);
  };

  const read = (sessionId: string, env: string) => {
    const lease = leases.get(key(sessionId, env));
    if (!lease) return null;
    if (lease.expiresAt <= now()) {
      drop(key(sessionId, env));
      return null;
    }
    return lease.value;
  };

  const keep = (sessionId: string, env: string, value: string) => {
    const entryKey = key(sessionId, env);
    drop(entryKey);
    const timer = setTimeout(() => leases.delete(entryKey), leaseMs);
    timer.unref?.();
    leases.set(entryKey, { value, expiresAt: now() + leaseMs, timer });
  };

  const forget = (sessionId: string) => {
    let count = 0;
    for (const entryKey of [...leases.keys()]) {
      if (!entryKey.startsWith(key(sessionId, ''))) continue;
      drop(entryKey);
      count += 1;
    }
    return count;
  };

  return { read, keep, forget };
};

const NUL = String.fromCharCode(0);

const ownValue = <T>(record: Record<string, T> | undefined, key: string) => (record && Object.hasOwn(record, key) ? record[key] : undefined);

const retainedValue = (values: SecretValues, env: string) => {
  const value = values[env];
  if (value === undefined) throw new TypeError(`Missing submitted secret: ${env}`);
  return value;
};

const prefixFunction = (text: string) => {
  const prefix = new Array<number>(text.length).fill(0);
  for (let index = 1; index < text.length; index += 1) {
    let length = prefix[index - 1] ?? 0;
    while (length > 0 && text[index] !== text[length]) length = prefix[length - 1] ?? 0;
    if (text[index] === text[length]) length += 1;
    prefix[index] = length;
  }
  return prefix;
};

const occurrencesOf = (value: string, text: string) => {
  const prefix = prefixFunction(value);
  const ranges: [number, number][] = [];
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    while (length > 0 && text[index] !== value[length]) length = prefix[length - 1] ?? 0;
    if (text[index] === value[length]) length += 1;
    if (length === value.length) {
      ranges.push([index - value.length + 1, index + 1]);
      length = prefix[length - 1] ?? 0;
    }
  }
  return ranges;
};

const leadingTailOf = (value: string, text: string) => {
  const prefix = prefixFunction(`${text.slice(0, value.length)}${NUL}${value}`);
  return prefix[prefix.length - 1] ?? 0;
};

export const redactSecrets = (text: string, values: SecretValues, { cutAtStart = false }: { cutAtStart?: boolean } = {}) => {
  const owner = new Array<string | null>(text.length).fill(null);
  const entries = Object.entries(values).filter(([, value]) => value.length > 0).sort(([, a], [, b]) => b.length - a.length);
  for (const [env, value] of entries) {
    const ranges = occurrencesOf(value, text);
    if (cutAtStart) ranges.push([0, leadingTailOf(value, text)]);
    const depth = new Int32Array(text.length + 1);
    for (const [start, end] of ranges) {
      depth[start] = (depth[start] ?? 0) + 1;
      depth[end] = (depth[end] ?? 0) - 1;
    }
    let open = 0;
    for (let index = 0; index < text.length; index += 1) {
      open += depth[index] ?? 0;
      if (open > 0 && owner[index] === null) owner[index] = env;
    }
  }
  const pieces = [];
  let shown = 0;
  for (let index = 0; index < text.length; index += 1) {
    const env = owner[index];
    if (env === null || owner[index - 1] === env) continue;
    pieces.push(text.slice(shown, index), `[secret:${env}]`);
    shown = index;
    while (shown < text.length && owner[shown] === env) shown += 1;
    index = shown - 1;
  }
  pieces.push(text.slice(shown));
  return pieces.join('');
};

const shownOutput = (raw: string, values: SecretValues) => {
  if (Buffer.byteLength(raw, 'utf8') < CAPTURE_BYTES - 3) return lastChars(redactSecrets(raw, values));
  let start = 0;
  while (raw.charCodeAt(start) === 0xfffd) start += 1;
  return { ...lastChars(redactSecrets(raw.slice(start), values, { cutAtStart: true })), truncated: true };
};

const lastChars = (text: string) => (text.length > OUTPUT_LIMIT ? { text: text.slice(-OUTPUT_LIMIT), truncated: true } : { text, truncated: false });

const runOnce = async ({ program, args, timeoutMs }: Pick<ReturnType<typeof normalizeSecretRun>, 'program' | 'args' | 'timeoutMs'>, { values, directory, signal, run }: { values: SecretValues; directory: string; signal: AbortSignal | undefined; run: CommandRunner }): Promise<SecretCommandResult> => {
  try {
    const { code, stdout, stderr } = await run(program, args, {
      cwd: directory,
      env: { ...process.env, ...values },
      timeoutMs,
      signal,
      killTree: true,
      keepTail: true,
      maxOutputBytes: CAPTURE_BYTES,
    });
    return { outcome: 'exited', exitCode: code, stdout, stderr };
  } catch (error) {
    if (signal?.aborted) throw new OpenChamberControlError('The call stopped while the command was running, and the command was stopped', 499);
    const outcome = controlErrorFields(error)?.code === 'command_timeout' ? 'timeout'
      : controlErrorFields(error)?.code === 'command_spawn_failed' ? 'not-started'
        : 'killed';
    return { outcome, exitCode: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) };
  }
};

export const createSecretRuns = ({ waits, hasUnreadChat, leases = createSecretLeases(), saved = null, run = runCommand }: SecretRunsOptions) => {
  const pending = new Map<string, SecretSlot>();
  const key = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

  const readSaved = async (directory: string) => {
    if (!saved) return null;
    try {
      return await saved.read(directory);
    } catch (error) {
      console.warn('[secret.run] saved secrets unavailable:', error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const savedEntry = (stored: StoredSecrets | null, env: string): { value: string; scope: SavedScope } | null => {
    const project = ownValue(stored?.project, env);
    if (project !== undefined) return { value: project, scope: 'project' };
    const global = ownValue(stored?.global, env);
    if (global !== undefined) return { value: global, scope: 'global' };
    return null;
  };

  const awaitCard = async (slot: Omit<SecretSlot, 'deliver'>, { sessionId, callId, title, directory, signal }: PageWaitOptions) => {
    const slotKey = key(sessionId, callId);
    const submission: SecretSubmission = { answer: null };
    pending.set(slotKey, { ...slot, deliver: (answer) => { submission.answer = answer; } });
    try {
      const answer = await waits.wait({ sessionId, callId, title: title.slice(0, SECRET_RUN_MAX_LABEL_LENGTH), directory, signal });
      if (answer.summary !== 'submitted' || !submission.answer) return null;
    } finally {
      pending.delete(slotKey);
    }
    if (signal?.aborted) throw new OpenChamberControlError('The card stopped waiting before the user answered', 499);
    return submission.answer;
  };

  const execute = async (input: SecretRunInput, { sessionId, callId, directory, signal, authorized }: SecretRunContext) => {
    if (!authorized) throw new OpenChamberControlError('secret.run is only available to agents, through the openchamber_secret tool', 403);
    const request = normalizeSecretRun(input);
    if (!sessionId || !callId) throw new OpenChamberControlError('This connection cannot wait for a secret', 400);
    if (!directory) throw new OpenChamberControlError('This session has no directory to run the command in', 400);

    const stored = await readSaved(directory);
    const values: SecretValues = {};
    const savedValues: SecretValues = {};
    const savedScopes: Record<string, SavedScope> = {};
    const missing: ReturnType<typeof normalizeSecretRun>['inputs'] = [];
    for (const field of request.inputs) {
      const value = leases.read(sessionId, field.env);
      const entry = value === null ? savedEntry(stored, field.env) : null;
      if (value !== null) values[field.env] = value;
      else if (entry) {
        savedValues[field.env] = entry.value;
        savedScopes[field.env] = entry.scope;
      } else missing.push(field);
    }
    const reused = Object.keys(values);

    if (await hasUnreadChat(sessionId)) {
      return { answer: { answered: false, reason: 'chat-sent-earlier' }, note: CHAT_SENT_EARLIER_NOTE };
    }
    let remember: string[] = [];
    let save: string[] = [];
    let saveGlobally: string[] = [];
    if (missing.length > 0 || Object.keys(savedValues).length > 0) {
      const submitted = await awaitCard(
        { kind: 'run', fields: missing.map((field) => field.env), reused, savedValues, savedScopes, savedInBoth: [], projectId: stored?.projectId ?? null, canSaveGlobally: stored !== null },
        { sessionId, callId, title: request.inputs.filter((field) => !reused.includes(field.env)).map((field) => field.label).join(', '), directory, signal },
      );
      if (!submitted) return { answer: { status: 'declined' }, note: DECLINED_NOTE };
      const confirmedSaved = Object.keys(savedValues).filter((env) => !Object.hasOwn(submitted.values, env));
      const current = confirmedSaved.length > 0 ? await readSaved(directory) : null;
      const changed = confirmedSaved.filter((env) => savedEntry(current, env)?.value !== savedValues[env]);
      if (changed.length > 0) {
        return {
          answer: { status: 'ran', outcome: 'not-started', exitCode: null },
          stdout: '',
          stderr: '',
          remembered: [],
          error: `${changed.join(', ')} stopped being saved while the card waited`,
          note: SAVED_CHANGED_NOTE,
        };
      }
      Object.assign(values, savedValues, submitted.values);
      remember = submitted.remember;
      save = submitted.save;
      saveGlobally = submitted.saveGlobally;
    }
    for (const env of remember) leases.keep(sessionId, env, retainedValue(values, env));
    const notSaved: string[] = [];
    const writes: [SavedScope, string[]][] = [['project', save], ['global', saveGlobally]];
    for (const [scope, names] of writes) {
      if (names.length === 0 || !saved) continue;
      try {
        await saved.write(scope, stored?.projectId ?? null, Object.fromEntries(names.map((env) => [env, retainedValue(values, env)])));
      } catch (error) {
        console.warn('[secret.run] could not save secrets:', error instanceof Error ? error.message : String(error));
        notSaved.push(...names);
      }
    }

    const result = await runOnce(request, { values, directory, signal, run });
    const stdout = shownOutput(result.stdout, values);
    const stderr = shownOutput(result.stderr, values);
    const remembered = request.inputs.map((field) => field.env).filter((env) => leases.read(sessionId, env) !== null);
    const data: SecretRunResult = {
      answer: { status: 'ran', outcome: result.outcome, exitCode: result.exitCode },
      stdout: stdout.text,
      stderr: stderr.text,
      remembered,
      note: RAN_NOTE,
    };
    const savedNames = request.inputs.map((field) => field.env)
      .filter((env) => (Object.hasOwn(savedValues, env) && values[env] === savedValues[env]) || ([...save, ...saveGlobally].includes(env) && !notSaved.includes(env)));
    if (savedNames.length > 0) data.saved = savedNames;
    if (notSaved.length > 0) data.notSaved = notSaved;
    if (stdout.truncated || stderr.truncated) data.truncated = { stdout: stdout.truncated, stderr: stderr.truncated };
    if (result.error) data.error = redactSecrets(result.error, values);
    return data;
  };

  const describe = (slot: SecretSlot) => ({
    fields: [...slot.fields, ...Object.keys(slot.savedValues)],
    reused: slot.reused,
    saved: Object.keys(slot.savedValues),
    savedGlobally: Object.keys(slot.savedValues).filter((env) => slot.savedScopes[env] === 'global'),
    savedInBoth: slot.savedInBoth.filter((env) => Object.hasOwn(slot.savedValues, env)),
    canSave: slot.projectId !== null,
    canSaveGlobally: slot.canSaveGlobally,
  });

  const fieldsFor = (sessionId: string, callId: string) => {
    const slot = pending.get(key(sessionId, callId));
    return slot ? describe(slot) : null;
  };

  const forgetSaved = async (sessionId: string, callId: string, env: string) => {
    const slot = pending.get(key(sessionId, callId));
    if (!slot) return null;
    if (slot.kind !== 'run') throw new OpenChamberControlError('This card forgets the saved secrets all together, not one by one', 400);
    if (slot.fields.includes(env)) return describe(slot);
    const value = ownValue(slot.savedValues, env);
    const scope = ownValue(slot.savedScopes, env);
    if (value === undefined || scope === undefined || !saved) throw new OpenChamberControlError(`${env} is not saved for this card`, 400);
    delete slot.savedValues[env];
    slot.fields = [...slot.fields, env];
    try {
      await saved.remove(slot.projectId, scope === 'project' ? { project: { [env]: value }, global: {} } : { project: {}, global: { [env]: value } });
    } catch (error) {
      if (controlErrorFields(error)?.statusCode === 409) throw error;
      slot.savedValues[env] = value;
      slot.fields = slot.fields.filter((field) => field !== env);
      throw error;
    }
    return describe(slot);
  };

  const submit = (sessionId: string, callId: string, input: SecretSubmissionInput, settle: SettleSecret) => {
    const slot = pending.get(key(sessionId, callId));
    const raw = input.values;
    if (!isValues(raw)) throw new OpenChamberControlError('values is required: one value per field', 400);
    const values: SecretValues = {};
    if (!slot) throw new TypeError("Cannot read properties of undefined (reading 'fields')");
    for (const env of slot.fields) {
      const value = raw[env];
      if (!isText(value) || !value.trim()) throw new OpenChamberControlError(`A value for ${env} is required`, 400);
      if (value.length > SECRET_MAX_VALUE_LENGTH) throw new OpenChamberControlError(`The value for ${env} is ${value.length} characters; the limit is ${SECRET_MAX_VALUE_LENGTH}`, 413);
      if (value.includes(NUL)) throw new OpenChamberControlError(`The value for ${env} contains a NUL character`, 400);
      values[env] = value;
    }
    for (const env of Object.keys(slot.savedValues)) {
      const value = ownValue(raw, env);
      if (value === undefined) continue;
      if (!isText(value) || !value.trim()) throw new OpenChamberControlError(`A value for ${env} is required`, 400);
      if (value.length > SECRET_MAX_VALUE_LENGTH) throw new OpenChamberControlError(`The value for ${env} is ${value.length} characters; the limit is ${SECRET_MAX_VALUE_LENGTH}`, 413);
      if (value.includes(NUL)) throw new OpenChamberControlError(`The value for ${env} contains a NUL character`, 400);
      values[env] = value;
    }
    const extra = Object.keys(raw).find((env) => !Object.hasOwn(values, env));
    if (extra) throw new OpenChamberControlError(`${extra} is not a field of this card`, 400);
    const confirmed = Array.isArray(input.saved) ? input.saved : [];
    const unseen = Object.keys(slot.savedValues).find((env) => !confirmed.includes(env) && !Object.hasOwn(values, env));
    if (unseen) throw new OpenChamberControlError(`The answer neither confirms the saved ${unseen} nor gives a value for it`, 409);
    const typed = (list: SecretSubmissionInput['save']) => (Array.isArray(list) ? [...new Set(list.filter((env): env is string => Object.hasOwn(values, env)))] : []);
    const save = slot.projectId ? typed(input.save) : [];
    const saveGlobally = slot.canSaveGlobally ? typed(input.saveGlobally).filter((env) => !save.includes(env)) : [];
    slot.deliver({ values, remember: typed(input.remember), save, saveGlobally });
    settle(sessionId, callId, 'submitted', null);
    return { status: 'submitted' };
  };

  const forget = async ({ includeSaved = false }: { includeSaved?: boolean }, { sessionId, callId, directory, signal }: SecretRunContext) => {
    if (!sessionId) throw new OpenChamberControlError('secret.forget needs the calling session', 400);
    if (includeSaved && saved && !directory) throw new OpenChamberControlError('This session has no directory to find its project in', 400);
    const forgotten = leases.forget(sessionId);
    if (!includeSaved) return { forgotten };
    if (!saved || !directory) return { forgotten, forgottenSaved: [] };
    const stored = await saved.read(directory);
    const projectNames = Object.keys(stored.project);
    const globalNames = Object.keys(stored.global);
    const names = [...new Set([...projectNames, ...globalNames])];
    if (names.length === 0) return { forgotten, forgottenSaved: [] };
    if (!callId) throw new OpenChamberControlError('This connection cannot wait for the user to confirm', 400);
    if (await hasUnreadChat(sessionId)) {
      return { forgotten, forgottenSaved: [], answer: { answered: false, reason: 'chat-sent-earlier' }, note: FORGET_CHAT_SENT_EARLIER_NOTE };
    }
    const savedScopes: Record<string, SavedScope> = Object.fromEntries(names.map((env) => [env, projectNames.includes(env) ? 'project' : 'global']));
    const confirmed = await awaitCard(
      { kind: 'forget', fields: [], reused: [], savedValues: { ...stored.global, ...stored.project }, savedScopes, savedInBoth: globalNames.filter((env) => projectNames.includes(env)), projectId: stored.projectId, canSaveGlobally: false },
      { sessionId, callId, title: names.join(', '), directory, signal },
    );
    if (!confirmed) return { forgotten, forgottenSaved: [], note: KEPT_NOTE };
    await saved.remove(stored.projectId, { project: stored.project, global: stored.global });
    return { forgotten, forgottenSaved: names };
  };

  return { execute, fieldsFor, submit, forgetSaved, forget };
};
