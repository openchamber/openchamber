// The host's channel to the server inside a space, written once on top of `exec` for every place.
// The space's network cannot see it: requests run as `curl` inside the space against loopback.
//
// This is what stage 1b uses. The `connect` operation of the place contract, a real
// streaming channel, belongs to the dispatcher stage.

import crypto from 'node:crypto';

import { SpaceError } from './errors.js';
import {
  IMAGE_CAT,
  IMAGE_CURL,
  IMAGE_ONLY_PATH,
  IMAGE_SH,
  SPACE_SERVER_HOST,
  SPACE_SERVER_PORT,
  SPACE_TOKEN_DIRECTORY,
  SPACE_TOKEN_PATH,
  TOOLS_PLUGIN_PATH,
  spaceWorkPath,
} from './layout.js';

const REQUEST_SECONDS = 20;
// Agent code can own the server port when a stopped space starts. A listener that accepts and
// never answers must cost one short attempt, not a long one, and the whole wait has a wall-clock end.
const HEALTH_SECONDS = 3;
const READY_TIMEOUT_MS = 120_000;
const READY_PAUSE_MS = 500;
// A second stop for a caller whose clock stands still. The deadline is the real limit.
const READY_MAX_ATTEMPTS = 1_000;
// How much text from inside a space an error message may carry.
const ERROR_TAIL_CHARACTERS = 2_000;

// Exit codes of a `docker exec` that failed by itself: no such container, container not running,
// curl missing. curl uses 1 too. Measured with curl 7.88.1: a listener that answers `hello` gives
// exit code 1 and `curl: (1) Received HTTP/0.9 when not allowed`. curl starts every error line
// with `curl:`, so one of these codes means "exec failed" only when stderr does not start like that.
const EXEC_FAILED_CODES = [1, 125, 126, 127];
const isFromCurl = (stderr) => String(stderr ?? '').trimStart().startsWith('curl:');

// How much of an answer's header block the host is willing to parse. The real server sends about 1 KB.
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_LINES = 200;

// The place makes 43 characters of base64url. Anything else in the token file is not a token.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const READ_TOKEN_TIMEOUT_MS = 10_000;
// The CLI of an exec was killed. For a request that says something about the inside, not about a Docker step.
const EXEC_INTERRUPTED_CODES = ['command_timeout', 'command_killed'];

// The token goes through a temporary name, so the waiting server never reads half of it.
const WRITE_TOKEN_SCRIPT = [
  IMAGE_ONLY_PATH,
  'umask 077;',
  `mkdir -p ${SPACE_TOKEN_DIRECTORY} && chmod 700 ${SPACE_TOKEN_DIRECTORY}`,
  `&& cat > ${SPACE_TOKEN_PATH}.new && mv ${SPACE_TOKEN_PATH}.new ${SPACE_TOKEN_PATH}`,
].join(' ');

// Module resolution walks up from the project files, so one link above every project is enough.
// Only the plugin is linked, so project code does not quietly resolve our other packages.
const LINK_PLUGIN_SCRIPT = `${IMAGE_ONLY_PATH} mkdir -p "$1/node_modules/@opencode-ai" && ln -sfn "$2" "$1/node_modules/@opencode-ai/plugin"`;

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

export const createSpaceToken = () => crypto.randomBytes(32).toString('base64url');

// A quoted value in a curl config file. Backslash escapes are the only special syntax inside the quotes.
const quoteConfigValue = (value) => {
  const text = String(value);
  if (text.includes('\0')) {
    throw new SpaceError('invalid_request', 'A request to the server inside a space cannot hold a NUL character');
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
};

const tail = (text) => String(text ?? '').trim().slice(-ERROR_TAIL_CHARACTERS);

// Whatever listens on the port wrote this text, and that may be agent code. It is data.
// Header names go into an object without a prototype, so `__proto__` or `constructor` is one more name.
const parseResponse = (output) => {
  const headerEnd = output.indexOf('\r\n\r\n');
  // The cap comes before any work on the header block, so a huge block costs the host nothing.
  if (headerEnd > MAX_HEADER_BYTES) {
    throw new SpaceError('space_server_answer_unreadable', `The server inside the space answered with more than ${MAX_HEADER_BYTES} bytes of headers`);
  }
  const [statusLine, ...headerLines] = output.slice(0, Math.max(headerEnd, 0)).split('\r\n');
  const status = Number.parseInt(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1] ?? '', 10);
  if (headerEnd < 0 || Number.isNaN(status)) {
    throw new SpaceError('space_server_answer_unreadable', 'The server inside the space answered with something that is not HTTP');
  }
  if (headerLines.length > MAX_HEADER_LINES) {
    throw new SpaceError('space_server_answer_unreadable', `The server inside the space answered with more than ${MAX_HEADER_LINES} header lines`);
  }
  const headers = Object.create(null);
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      // Pushed, not copied: a copy per line is quadratic in the lines that the inside chooses to send.
      headers[name] ??= [];
      headers[name].push(line.slice(colon + 1).trim());
    }
  }
  return { status, headers, body: output.slice(headerEnd + 4) };
};

// The real health answer is a few hundred bytes. A larger one is not worth the time to parse.
const MAX_HEALTH_BODY_CHARACTERS = 64 * 1024;

const reportsReady = (answer) => {
  if (answer.status !== 200 || answer.body.length > MAX_HEALTH_BODY_CHARACTERS) {
    return false;
  }
  try {
    return JSON.parse(answer.body)?.isOpenCodeReady === true;
  } catch {
    return false;
  }
};

/**
 * `exec` is the place operation: `(spaceId, argv, { stdin, timeoutMs })`.
 * `wait` is the pause between readiness attempts and `now` the clock in milliseconds.
 * Both are injectable so tests do not sleep.
 *
 * Everything that comes back from inside a space is untrusted. No answer from inside
 * makes this module throw anything but a SpaceError.
 */
export function createSpaceServerChannel({ exec, wait = pause, now = Date.now }) {
  const runFixedScript = async (spaceId, argv, stdin, what) => {
    const result = await exec(spaceId, argv, { stdin });
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not ${what} inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
    return result.stdout;
  };

  /** The token travels on stdin. It never appears in an argument, on the host or inside. */
  const writeToken = (spaceId, token) => runFixedScript(spaceId, [IMAGE_SH, '-c', WRITE_TOKEN_SCRIPT], token, 'store the server token');

  /**
   * The host keeps no copy of the token. It reads it back when it needs it.
   * The agent owns the file. It can make it huge, empty, or a FIFO that never ends, so the read has
   * a short time limit and the result must look like a token.
   */
  const readToken = async (spaceId) => {
    const unreadable = (why) => new SpaceError('space_token_unreadable', `The token file of the server inside the space ${why}. Something inside the space changed it.`);
    let result;
    try {
      result = await exec(spaceId, [IMAGE_CAT, SPACE_TOKEN_PATH], { stdin: '', timeoutMs: READ_TOKEN_TIMEOUT_MS });
    } catch (error) {
      if (error.code === 'command_output_too_large') throw unreadable('is far too large');
      if (EXEC_INTERRUPTED_CODES.includes(error.code)) throw unreadable('could not be read in time');
      throw error;
    }
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not read the server token inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
    const token = result.stdout.trim();
    if (!TOKEN_PATTERN.test(token)) {
      throw unreadable(token === '' ? 'is empty' : 'does not hold a token');
    }
    return token;
  };

  const linkPlugin = (spaceId) => runFixedScript(spaceId, [IMAGE_SH, '-c', LINK_PLUGIN_SCRIPT, 'sh', spaceWorkPath(spaceId), TOOLS_PLUGIN_PATH], '', 'link the OpenCode plugin');

  /**
   * One HTTP request to the server inside. Resolves `{ status, headers, body }` for any status.
   * The whole request, with its headers and body, is a curl config on stdin, so a cookie or
   * a token in it shows up in no argument list. `headers` values are arrays, a header can repeat.
   */
  const request = async (spaceId, { method = 'GET', path, headers = {}, body = null, timeoutSeconds = REQUEST_SECONDS }) => {
    const config = [
      `url = ${quoteConfigValue(`http://${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}${path}`)}`,
      `request = ${quoteConfigValue(method)}`,
      // Without this curl asks "Expect: 100-continue" for a large body and the answer gets two header blocks.
      'header = "Expect:"',
      ...Object.entries(headers).map(([name, value]) => `header = ${quoteConfigValue(`${name}: ${value}`)}`),
      // `data-raw`, because `data-binary` reads a body that starts with `@` as a file name.
      ...(body === null ? [] : [`data-raw = ${quoteConfigValue(body)}`]),
    ].join('\n');
    let result;
    try {
      result = await exec(
        spaceId,
        // `--disable` must come first. It keeps curl away from the `~/.curlrc` of the space user, which the agent can write.
        [IMAGE_CURL, '--disable', '--silent', '--show-error', '--include', '--max-time', String(timeoutSeconds), '--config', '-'],
        { stdin: `${config}\n`, timeoutMs: (timeoutSeconds + 10) * 1000 },
      );
    } catch (error) {
      // Too much output is an answer from inside, not an interrupted Docker step.
      if (error.code === 'command_output_too_large') {
        throw new SpaceError('space_server_answer_unreadable', 'The server inside the space answered with more data than the host accepts');
      }
      // No Docker step was interrupted here, so this must not look like one to a rollback.
      if (EXEC_INTERRUPTED_CODES.includes(error.code)) {
        throw new SpaceError('space_server_unreachable', `The request to the server inside the space did not finish in time: ${error.message}`, { curlExitCode: null, execFailed: false });
      }
      throw error;
    }
    if (result.code !== 0) {
      throw new SpaceError(
        'space_server_unreachable',
        `The server inside the space did not answer: ${tail(result.stderr) || `curl exit code ${result.code}`}`,
        { curlExitCode: result.code, execFailed: EXEC_FAILED_CODES.includes(result.code) && !isFromCurl(result.stderr) },
      );
    }
    return parseResponse(result.stdout);
  };

  /**
   * Resolves when `/health` answers and reports OpenCode ready. The wait ends at a wall-clock
   * deadline, whatever the thing on the port does. An unreadable answer, a wrong answer, and no
   * answer all count as "not ready yet". Only a failure of `exec` itself ends the wait early.
   */
  const waitUntilReady = async (spaceId) => {
    const started = now();
    let last = 'no answer yet';
    for (let attempt = 0; attempt < READY_MAX_ATTEMPTS && now() - started < READY_TIMEOUT_MS; attempt += 1) {
      try {
        if (reportsReady(await request(spaceId, { path: '/health', timeoutSeconds: HEALTH_SECONDS }))) {
          return;
        }
        last = 'the answer does not report OpenCode ready';
      } catch (error) {
        const fromInside = error.code === 'space_server_answer_unreadable'
          || (error.code === 'space_server_unreachable' && error.details?.execFailed !== true);
        if (!fromInside) {
          throw error;
        }
        last = error.message;
      }
      await wait(READY_PAUSE_MS);
    }
    throw new SpaceError(
      'space_server_not_ready',
      `The server inside the space did not become ready within ${Math.round((now() - started) / 1000)} seconds (${last}). Look at the output of the space container, and check that the space has enough memory.`,
    );
  };

  return { writeToken, readToken, linkPlugin, request, waitUntilReady };
}
