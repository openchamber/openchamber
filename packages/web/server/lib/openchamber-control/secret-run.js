import { isRecord, isString } from '../shared/guards.js';
import { runCommand } from '../spaces/run-command.js';
import { OpenChamberControlError } from './error.js';

export const SECRET_RUN_MAX_INPUTS = 8;
const SECRET_RUN_MAX_REASON_LENGTH = 1000;
export const SECRET_RUN_MAX_LABEL_LENGTH = 120;
export const SECRET_RUN_MAX_PLACEHOLDER_LENGTH = 80;
export const SECRET_RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const SECRET_RUN_MAX_TIMEOUT_MS = 600_000;
// A remembered value is reused for this long after the user submitted it; use does not extend it.
export const SECRET_LEASE_MS = 10 * 60_000;
const SECRET_MAX_VALUE_LENGTH = 16_000;
// The child prints into a 1 MB window; the agent gets the last 32,000 characters of it.
const CAPTURE_BYTES = 1024 * 1024;
const OUTPUT_LIMIT = 32_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const RAN_NOTE = "The command ran once, with the secrets in its environment. In stdout and stderr every secret value is replaced by [secret:NAME]. Fix a failing command and call secret.run again; the env names in remembered are reused without asking the user while they last.";
const DECLINED_NOTE = "The user declined to give the secrets, so the command did not run. Continue without it or say what it blocks; ask again only if they want to.";
const CHAT_SENT_EARLIER_NOTE = "The card did not wait and the command did not run: the user had already written in the chat before it appeared, and that message follows this result. Continue from that message; call again only if it still fits.";

/**
 * The command line the user approves and reads on the card: each argument
 * bare when it is plain, else in single quotes. Characters that draw nothing
 * or reorder text (controls, bidirectional marks) show as `\u{XXXX}`, so an
 * argument cannot make the line read differently from what runs.
 *
 * Self-contained: the agent tool's plugin embeds it with `toString()` to show
 * the same line in OpenCode's permission request.
 */
export function secretRunCommandLine(program, args) {
  // C0 and C1 controls, the Arabic letter mark, zero-width and direction marks,
  // line and paragraph separators, embeddings and overrides, isolates, BOM.
  const hidden = (code) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x61c
    || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff;
  const visible = (value) => Array.from(value, (char) => {
    const code = char.codePointAt(0);
    return hidden(code) ? `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}` : char;
  }).join('');
  const word = (value) => (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(value) ? value : `'${visible(value).replaceAll("'", "'\\''")}'`);
  return [program, ...args].map(word).join(' ');
}

/**
 * The program and arguments of a `secret.run` call, or the reason they are
 * refused. The plugin checks the call with it before it asks for permission,
 * so a malformed call never shows a permission request. It embeds this
 * function with `toString()`, so it uses nothing from outside itself: a
 * transformed import (vitest rewrites them) would not resolve in the plugin.
 * A script passed to `sh -c` is one argument, so the length bound is on the
 * whole line.
 */
export function secretRunCommand(input) {
  const isText = (value) => Object.prototype.toString.call(value) === '[object String]';
  const program = isText(input?.program) ? input.program.trim() : '';
  if (!program) return { error: 'program is required: the executable to run, by name on PATH or by absolute path. It runs without a shell; for a script pass program "sh" (or "bash") with args ["-c", "<script>"]' };
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || !args.every(isText)) return { error: 'args must be an array of strings' };
  if (args.length > 64) return { error: `args has ${args.length} entries; the limit is 64` };
  const length = program.length + args.reduce((total, arg) => total + arg.length + 1, 0);
  if (length > 32000) return { error: `The command is ${length} characters; the limit is 32000. Put a long script in a file and run that` };
  return { program, args };
}

const readText = (value) => (isString(value) ? value.trim() : '');

const refuse = (message) => new OpenChamberControlError(message, 400);

/** A `secret.run` input checked and normalized, or a 400 that names what to fix. */
const normalizeSecretRun = (input = {}) => {
  const command = secretRunCommand(input);
  if (command.error) throw refuse(command.error);
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
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > SECRET_RUN_MAX_TIMEOUT_MS) {
      throw refuse(`timeoutMs must be a whole number of milliseconds from 1 to ${SECRET_RUN_MAX_TIMEOUT_MS}`);
    }
    timeoutMs = input.timeoutMs;
  }
  return { ...command, reason, inputs, timeoutMs };
};

/**
 * Values the user let a chat keep, by session and environment name, each for
 * `SECRET_LEASE_MS` from when they submitted it. Only memory holds them, so a
 * restart forgets them all.
 */
export const createSecretLeases = ({ now = Date.now, leaseMs = SECRET_LEASE_MS } = {}) => {
  const leases = new Map();
  const key = (sessionId, env) => `${sessionId}\u0000${env}`;

  const drop = (entryKey) => {
    const lease = leases.get(entryKey);
    if (!lease) return;
    clearTimeout(lease.timer);
    leases.delete(entryKey);
  };

  const read = (sessionId, env) => {
    const lease = leases.get(key(sessionId, env));
    if (!lease) return null;
    if (lease.expiresAt <= now()) {
      drop(key(sessionId, env));
      return null;
    }
    return lease.value;
  };

  const keep = (sessionId, env, value) => {
    const entryKey = key(sessionId, env);
    drop(entryKey);
    const timer = setTimeout(() => leases.delete(entryKey), leaseMs);
    timer.unref?.();
    leases.set(entryKey, { value, expiresAt: now() + leaseMs, timer });
  };

  const forget = (sessionId) => {
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

/** The prefix function of `text`: at each position, the longest proper prefix that also ends there. */
const prefixFunction = (text) => {
  const prefix = new Array(text.length).fill(0);
  for (let index = 1; index < text.length; index += 1) {
    let length = prefix[index - 1];
    while (length > 0 && text[index] !== text[length]) length = prefix[length - 1];
    if (text[index] === text[length]) length += 1;
    prefix[index] = length;
  }
  return prefix;
};

/** Every place `value` occurs in `text`, overlapping ones included, as [start, end) ranges, in linear time. */
const occurrencesOf = (value, text) => {
  const prefix = prefixFunction(value);
  const ranges = [];
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    while (length > 0 && text[index] !== value[length]) length = prefix[length - 1];
    if (text[index] === value[length]) length += 1;
    if (length === value.length) {
      ranges.push([index - value.length + 1, index + 1]);
      length = prefix[length - 1];
    }
  }
  return ranges;
};

/** How many characters at the start of `text` are the end of `value`. Values never hold NUL, so no match runs across it. */
const leadingTailOf = (value, text) => {
  const prefix = prefixFunction(`${text.slice(0, value.length)}${NUL}${value}`);
  return prefix[prefix.length - 1];
};

/**
 * `text` with every character that belongs to a secret value hidden: each run
 * of them becomes `[secret:NAME]`, the longest value naming a character two
 * values cover. All ranges are found on the original text and hidden together
 * (a value inside another, overlapping occurrences, and with `cutAtStart` the
 * end of a value the text starts with), so hiding one can never shift the text
 * into a new partial match.
 */
export const redactSecrets = (text, values, { cutAtStart = false } = {}) => {
  const owner = new Array(text.length).fill(null);
  const entries = Object.entries(values).filter(([, value]) => value.length > 0).sort(([, a], [, b]) => b.length - a.length);
  for (const [env, value] of entries) {
    const ranges = occurrencesOf(value, text);
    if (cutAtStart) ranges.push([0, leadingTailOf(value, text)]);
    // Covered positions through a difference array, so overlapping ranges cost nothing extra.
    const depth = new Int32Array(text.length + 1);
    for (const [start, end] of ranges) {
      depth[start] += 1;
      depth[end] -= 1;
    }
    let open = 0;
    for (let index = 0; index < text.length; index += 1) {
      open += depth[index];
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

/**
 * The output a run returns. A window the runner cut at its byte limit can
 * start inside a secret, where that piece no longer matches the value, so its
 * start is hidden as the end of a value too.
 */
const shownOutput = (raw, values) => {
  if (Buffer.byteLength(raw, 'utf8') < CAPTURE_BYTES - 3) return lastChars(redactSecrets(raw, values));
  // A cut inside a multi-byte character decodes as replacement characters first.
  let start = 0;
  while (raw.charCodeAt(start) === 0xfffd) start += 1;
  return { ...lastChars(redactSecrets(raw.slice(start), values, { cutAtStart: true })), truncated: true };
};

const lastChars = (text) => (text.length > OUTPUT_LIMIT ? { text: text.slice(-OUTPUT_LIMIT), truncated: true } : { text, truncated: false });

/** What one run of the command came to: its exit, or why it did not finish. */
const runOnce = async ({ program, args, timeoutMs }, { values, directory, signal, run }) => {
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
    const outcome = error?.code === 'command_timeout' ? 'timeout'
      : error?.code === 'command_spawn_failed' ? 'not-started'
        : 'killed';
    return { outcome, exitCode: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * `secret.run`: the card asks the user for the secrets a command needs, and
 * the server runs that command once with them in its environment, in the
 * session's directory. The values never enter the call, its result, a file,
 * or the agent's context; the output the agent gets has them replaced.
 *
 * `waits` is the secret card's `createPageAnswers`, shared with
 * `secret.request`, so the answer route reaches both. While a card waits,
 * `fieldsFor` names the fields it asks for, the ones the chat still remembers
 * left out; the card reads them once the wait is announced.
 * `authorized` is true only for a call from the agent tool, whose plugin asked
 * OpenCode's shell permission for this command line first.
 */
export const createSecretRuns = ({ waits, hasUnreadChat, leases = createSecretLeases(), run = runCommand }) => {
  // The calls whose card waits, by session and call id, and the fields each asks for.
  const pending = new Map();
  const key = (sessionId, callId) => `${sessionId}\u0000${callId}`;

  const execute = async (input, { sessionId, callId, directory, signal, authorized }) => {
    if (!authorized) throw new OpenChamberControlError('secret.run is only available to agents, through the openchamber_secret tool', 403);
    const request = normalizeSecretRun(input);
    if (!sessionId || !callId) throw new OpenChamberControlError('This connection cannot wait for a secret', 400);
    if (!directory) throw new OpenChamberControlError('This session has no directory to run the command in', 400);

    const values = {};
    const missing = [];
    for (const field of request.inputs) {
      const value = leases.read(sessionId, field.env);
      if (value === null) missing.push(field);
      else values[field.env] = value;
    }
    const reused = Object.keys(values);

    // A message the user wrote while OpenCode asked to approve the command
    // comes first, also when the chat remembers every value and no card shows.
    if (await hasUnreadChat(sessionId)) {
      return { answer: { answered: false, reason: 'chat-sent-earlier' }, note: CHAT_SENT_EARLIER_NOTE };
    }
    let remember = [];
    if (missing.length > 0) {
      const slotKey = key(sessionId, callId);
      let submitted = null;
      pending.set(slotKey, { fields: missing.map((field) => field.env), reused, deliver: (answer) => { submitted = answer; } });
      try {
        const title = missing.map((field) => field.label).join(', ').slice(0, SECRET_RUN_MAX_LABEL_LENGTH);
        const answer = await waits.wait({ sessionId, callId, title, directory, signal });
        if (answer.summary !== 'submitted' || !submitted) {
          return { answer: { status: 'declined' }, note: DECLINED_NOTE };
        }
      } finally {
        pending.delete(slotKey);
      }
      if (signal?.aborted) throw new OpenChamberControlError('The card stopped waiting before the user answered', 499);
      Object.assign(values, submitted.values);
      remember = submitted.remember;
    }
    // Kept before the run, so a command that fails can be fixed and run again without asking.
    for (const env of remember) leases.keep(sessionId, env, values[env]);

    const result = await runOnce(request, { values, directory, signal, run });
    const stdout = shownOutput(result.stdout, values);
    const stderr = shownOutput(result.stderr, values);
    const remembered = request.inputs.map((field) => field.env).filter((env) => leases.read(sessionId, env) !== null);
    const data = {
      answer: { status: 'ran', outcome: result.outcome, exitCode: result.exitCode },
      stdout: stdout.text,
      stderr: stderr.text,
      remembered,
      note: RAN_NOTE,
    };
    // Each only when it says something, so a plain run reads short.
    if (stdout.truncated || stderr.truncated) data.truncated = { stdout: stdout.truncated, stderr: stderr.truncated };
    if (result.error) data.error = redactSecrets(result.error, values);
    return data;
  };

  /** What this call's card asks for (`fields`) and reuses (`reused`), or null when it is not waiting for a run. */
  const fieldsFor = (sessionId, callId) => {
    const slot = pending.get(key(sessionId, callId));
    return slot ? { fields: slot.fields, reused: slot.reused } : null;
  };

  /**
   * The card's answer: exactly the asked fields, each non-empty, and the ones
   * the user let the chat remember. Settles the wait as `submitted`; the
   * values travel past it in memory and never through the wait's data.
   */
  const submit = (sessionId, callId, input, settle) => {
    const slot = pending.get(key(sessionId, callId));
    const raw = input.values;
    if (!isRecord(raw)) throw new OpenChamberControlError('values is required: one value per field', 400);
    const values = {};
    for (const env of slot.fields) {
      const value = raw[env];
      if (!isString(value) || !value.trim()) throw new OpenChamberControlError(`A value for ${env} is required`, 400);
      if (value.length > SECRET_MAX_VALUE_LENGTH) throw new OpenChamberControlError(`The value for ${env} is ${value.length} characters; the limit is ${SECRET_MAX_VALUE_LENGTH}`, 413);
      // No program can receive it, and the runtime would quote it in its error.
      if (value.includes(NUL)) throw new OpenChamberControlError(`The value for ${env} contains a NUL character`, 400);
      values[env] = value;
    }
    const extra = Object.keys(raw).find((env) => !slot.fields.includes(env));
    if (extra) throw new OpenChamberControlError(`${extra} is not a field of this card`, 400);
    const remember = Array.isArray(input.remember) ? [...new Set(input.remember.filter((env) => slot.fields.includes(env)))] : [];
    slot.deliver({ values, remember });
    settle(sessionId, callId, 'submitted', null);
    return { status: 'submitted' };
  };

  const forget = (sessionId) => {
    if (!sessionId) throw new OpenChamberControlError('secret.forget needs the calling session', 400);
    return { forgotten: leases.forget(sessionId) };
  };

  return { execute, fieldsFor, submit, forget };
};
