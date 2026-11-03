import path from 'node:path';

/**
 * @module antigravity/cli
 *
 * The Antigravity CLI (`agy`) as this server runs it: where the binary is,
 * which arguments a delegated task becomes, and how a failure is classified.
 *
 * Everything here is pure or near-pure so the runtime, the settings status
 * route and the managed plugin share one behavior. Only `resolveBinary` and
 * `runProcess` touch the filesystem or spawn.
 */

/** Package and CLI names, kept in one place for messages and diagnostics. */
export const AGY_COMMAND = 'agy';
export const ANTIGRAVITY_CLI_INSTALL_URL = 'https://antigravity.google/docs/getting-started/';

/**
 * A model id or conversation id is passed as an argv value. Both are chosen by
 * the model or come from the CLI's own envelope, so only the shapes Antigravity
 * uses are accepted; anything else is rejected before it can become an
 * argument.
 */
const ARGUMENT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isValidArgumentToken = (value) => (
  typeof value === 'string' && ARGUMENT_TOKEN_PATTERN.test(value)
);

/**
 * Remove credentials from text shown to the model or a user. The CLI child
 * inherits proxy variables, and an error can echo them; nothing that looks
 * like a secret leaves this module.
 */
export const redactSecrets = (text) => {
  if (!text) return text;
  return String(text)
    // `scheme://user:password@host` in a proxy URL or a page the CLI printed.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{6,}/g, '[redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{6,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{4,}/g, '[redacted]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?[^\s"']+/gi, '$1=[redacted]');
};


/** A delegated task may not run longer than this, whatever a model asks for. */
export const MAX_RUN_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = MAX_RUN_TIMEOUT_MS;

/**
 * Variables the CLI child may inherit. The server environment carries provider
 * keys and other secrets a model-driven child has no business reading, so the
 * child gets an explicit list. Windows entries matter: without `APPDATA` and
 * `LOCALAPPDATA` the CLI cannot find its own sign-in state.
 */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'USERPROFILE',
  'SHELL',
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROCESSOR_ARCHITECTURE',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

/** The child environment from the allowlist; keys keep their original casing. */
export const buildChildEnv = (baseEnv = process.env) => {
  const env = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = baseEnv[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
};

/**
 * Locate the CLI on `PATH`.
 *
 * A bare command is not enough: the managed OpenCode child inherits a smaller
 * environment than the server, and Windows resolves executables through
 * `PATHEXT`. Resolving once here lets every failure name a real path and keeps
 * the plugin from depending on how it was launched.
 *
 * @returns {string | null} absolute path when found
 */
export const resolveBinary = ({ platform = process.platform, env = process.env, isFile }) => {
  const windows = platform === 'win32';
  const name = windows ? `${AGY_COMMAND}.exe` : AGY_COMMAND;
  const separator = windows ? ';' : ':';
  const join = windows ? path.win32.join : path.posix.join;
  const entries = String(env.PATH ?? '').split(separator).filter(Boolean);
  for (const entry of entries) {
    const candidate = join(entry.replace(/^"(.*)"$/, '$1'), name);
    if (isFile(candidate)) return candidate;
  }
  return null;
};

/**
 * `agy models` prints `id<TAB>Name` per line and progress chatter on stderr.
 * Keep only well-formed rows so a banner or a warning never becomes a model.
 *
 * @returns {Array<{id: string, name: string}>}
 */
export const parseModelsOutput = (text) => {
  const models = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    // The CLI separates the id from the display name with a tab; requiring it
    // keeps progress chatter ("Fetching available models...") out of the list.
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\t+(\S.*)$/);
    if (!match) continue;
    const id = match[1];
    const name = match[2].trim();
    if (!name || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return models;
};

/** Normalize a timeout input (ms number, `"5m"`, `"300s"`) into milliseconds. */
export const parseTimeoutMs = (value, fallback = DEFAULT_RUN_TIMEOUT_MS) => {
  if (value == null) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(Math.trunc(value), MAX_TIMEOUT_MS);
  }
  if (typeof value !== 'string') return fallback;
  const match = value.trim().match(/^(\d+)\s*(h|m|s|ms)$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  const unit = match[2].toLowerCase();
  const ms = unit === 'h' ? amount * 3_600_000
    : unit === 'm' ? amount * 60_000
      : unit === 's' ? amount * 1_000
        : amount;
  return Math.min(ms, MAX_TIMEOUT_MS);
};

/** Format milliseconds as the CLI's duration syntax, rounding up to whole seconds. */
export const formatTimeout = (ms) => {
  const seconds = Math.max(1, Math.ceil(ms / 1_000));
  return `${seconds}s`;
};

/**
 * The argv for one delegated task.
 *
 * `--output-format json` is deliberate: a permission-denied headless run and a
 * print timeout both exit 0 with `status: SUCCESS` and an empty response in
 * some versions, and only the envelope carries `status`, `error` and
 * `finished_reason`. `--disable-slash-commands` keeps a task that begins with
 * `/` literal instead of expanding a CLI command.
 */
export const buildRunArgs = ({ model, prompt, timeoutMs, conversationId, skipPermissions = false }) => {
  const args = [
    '--print', prompt,
    '--output-format', 'json',
    '--print-timeout', formatTimeout(timeoutMs),
    '--disable-slash-commands',
  ];
  // Auto-approval is only ever offered together with the terminal sandbox, so
  // an approved command still runs inside the CLI's own confinement. The
  // setting behind this is host-owned; the model cannot ask for it.
  if (skipPermissions) {
    args.push('--dangerously-skip-permissions', '--sandbox');
  }
  if (model) args.push('--model', model);
  if (conversationId) args.push('--conversation', conversationId);
  return args;
};

export const buildModelsArgs = () => ['models'];
export const buildVersionArgs = () => ['--version'];

const AUTH_PATTERN = /unauthenticated|unauthori[sz]ed|not signed in|sign[ -]?in\b|authenticate|credentials|oauth/i;
const PERMISSION_PATTERN = /permission[^\n]*(headless|denied|required|auto-?denied)|auto-?denied|denied by (a )?pre-tool hook|denied by pre-tool hook/i;
const QUOTA_PATTERN = /quota|rate[ _-]?limit|resource[ _-]?exhausted|too many requests|402|429/i;
const MODEL_PATTERN = /not recognized as a known model|unknown model|model .*not found|invalid model selection/i;

/**
 * Turn a failure into the code the tool result shows. The model acts on the
 * code, so it names what can be fixed: signing in, waiting for quota, another
 * model, a missing CLI.
 */
export const classifyFailure = ({ message = '', exitCode = 0 } = {}) => {
  if (exitCode === 124 || exitCode === 143) return 'TIMEOUT';
  if (MODEL_PATTERN.test(message)) return 'MODEL_NOT_FOUND';
  if (PERMISSION_PATTERN.test(message)) return 'PERMISSION_DENIED';
  if (AUTH_PATTERN.test(message)) return 'AUTH_REQUIRED';
  if (QUOTA_PATTERN.test(message)) return 'QUOTA_EXHAUSTED';
  if (/print[ -]?timeout|timed out|deadline exceeded/i.test(message)) return 'TIMEOUT';
  return 'AGY_FAILED';
};

/** Read the single JSON envelope from stdout; tolerate a leading log line. */
export const parseEnvelope = (stdout) => {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && ('status' in value || 'response' in value)) return value;
    } catch {
      // A truncated last line is a broken stream, not a result.
    }
  }
  return null;
};

/**
 * The user-facing outcome of one envelope. Throws an error carrying `code` and
 * `details` so the caller can build one result shape for every failure.
 */
export class AntigravityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'AntigravityError';
    this.code = code;
    this.details = details;
  }
}

export const outcomeFromEnvelope = ({ envelope, stderr, exitCode, durationMs, model }) => {
  const status = envelope?.status;
  const finishedReason = envelope?.finished_reason;
  if (finishedReason === 'print_timeout' || status === 'TIMEOUT') {
    throw new AntigravityError('Antigravity reached its print timeout before answering.', 'TIMEOUT', {
      stderr: redactSecrets(String(stderr ?? '').slice(-2000)),
      durationMs,
      model,
    });
  }
  if (status && status !== 'SUCCESS') {
    const message = envelope?.error || status;
    throw new AntigravityError(redactSecrets(message), classifyFailure({ message, exitCode }), {
      status,
      conversationId: envelope?.conversation_id || null,
      stderr: redactSecrets(String(stderr ?? '').slice(-2000)),
      durationMs,
      model,
    });
  }
  const response = typeof envelope?.response === 'string' ? envelope.response : '';
  if (!response.trim()) {
    // Headless soft-denies a tool it cannot get approval for: exit 0, SUCCESS,
    // empty response, and the notice on stderr. Reporting "no output" would
    // hide the one sentence that explains it.
    const notice = redactSecrets(String(stderr ?? '').trim());
    throw new AntigravityError(
      notice || 'Antigravity returned no output. A tool that needed approval may have been denied in headless mode.',
      classifyFailure({ message: notice, exitCode }),
      { conversationId: envelope?.conversation_id || null, stderr: notice.slice(-2000), durationMs, model },
    );
  }
  return {
    response: response.trimEnd(),
    conversationId: envelope?.conversation_id || null,
    usage: envelope?.usage ?? null,
    durationMs: Math.round(Number(envelope?.duration_seconds ?? 0) * 1000) || durationMs,
    model,
  };
};
