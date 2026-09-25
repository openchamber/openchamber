// The host's channel to the gatekeeper of a space, written once on top of `exec` for every place.
// The space cannot see it: the control listener binds the gatekeeper's own loopback, and the
// requests run as `curl` inside the gatekeeper container.
//
// Every secret the host delivers, a grant's key above all, travels on the stdin of an `exec` as a
// curl config. It is in no argument list, on the host or inside, in no label and in no file.

import { readFileSync } from 'node:fs';

import { SpaceError } from './errors.js';
import {
  EXEC_FAILED_CODES,
  EXEC_INTERRUPTED_CODES,
  buildCurlArgs,
  buildCurlConfig,
  isFromCurl,
  parseResponse,
  tail,
} from './exec-http.js';
import { ROLE_GATEKEEPER } from './labels.js';
import {
  GATEKEEPER_CONTROL_HOST,
  GATEKEEPER_CONTROL_PORT,
  GATEKEEPER_PROGRAM_DIRECTORY,
  GATEKEEPER_PROGRAM_PATH,
  IMAGE_ONLY_PATH,
  IMAGE_SH,
} from './layout.js';

/**
 * The gatekeeper's program, read from the file beside this one. `packages/web` ships `server/`
 * as plain files, so this works in the published package as it does in a checkout.
 */
export const GATEKEEPER_PROGRAM = readFileSync(new URL('./gatekeeper-program.cjs', import.meta.url), 'utf8');

const REQUEST_SECONDS = 20;
// The gatekeeper answers in milliseconds. A long attempt would only delay the wall-clock deadline.
const HEALTH_SECONDS = 3;
const READY_TIMEOUT_MS = 60_000;
const READY_PAUSE_MS = 250;
// A second stop for a caller whose clock stands still. The deadline is the real limit.
const READY_MAX_ATTEMPTS = 1_000;

// A journal record is five small fields. These caps are what the host is willing to read back.
const MAX_JOURNAL_RECORDS = 1_000;
const MAX_JOURNAL_BODY_CHARACTERS = 1024 * 1024;
const MAX_JOURNAL_FIELD_CHARACTERS = 256;

// The program goes through a temporary name, so the waiting container never runs half a file.
const WRITE_PROGRAM_SCRIPT = [
  IMAGE_ONLY_PATH,
  `mkdir -p ${GATEKEEPER_PROGRAM_DIRECTORY}`,
  `&& cat > ${GATEKEEPER_PROGRAM_PATH}.new && mv ${GATEKEEPER_PROGRAM_PATH}.new ${GATEKEEPER_PROGRAM_PATH}`,
].join(' ');

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const unreadableAnswer = (why) => new SpaceError('gatekeeper_answer_unreadable', `The gatekeeper of the space ${why}`);

/**
 * One field of a journal record, as text and no longer than the host reads. A list or an object
 * where a field should be comes out empty, because a record's fields are text and numbers.
 */
const text = (value) => (value === null || value === undefined || value instanceof Object ? '' : String(value).slice(0, MAX_JOURNAL_FIELD_CHARACTERS));

/**
 * `exec` is the place operation: `(spaceId, argv, { stdin, timeoutMs, target })`. `target` names
 * the container, and this channel always asks for the gatekeeper.
 *
 * Everything that comes back is untrusted, exactly as with the server inside a space. No answer
 * makes this module throw anything but a SpaceError.
 */
export function createGatekeeperChannel({ exec, wait = pause, now = Date.now }) {
  const execInGatekeeper = (spaceId, argv, options) => exec(spaceId, argv, { ...options, target: ROLE_GATEKEEPER });

  /** The program travels on stdin. It is in no argument, on the host or inside. */
  const writeProgram = async (spaceId) => {
    const result = await execInGatekeeper(spaceId, [IMAGE_SH, '-c', WRITE_PROGRAM_SCRIPT], { stdin: GATEKEEPER_PROGRAM });
    if (result.code !== 0) {
      throw new SpaceError('gatekeeper_setup_failed', `Could not store the gatekeeper's program: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
  };

  /** One HTTP request to the control listener. Resolves `{ status, headers, body }` for any status. */
  const request = async (spaceId, { method = 'GET', path, body = null, timeoutSeconds = REQUEST_SECONDS }) => {
    const config = buildCurlConfig({
      url: `http://${GATEKEEPER_CONTROL_HOST}:${GATEKEEPER_CONTROL_PORT}${path}`,
      method,
      headers: body === null ? {} : { 'Content-Type': 'application/json' },
      body,
    });
    let result;
    try {
      result = await execInGatekeeper(spaceId, buildCurlArgs(timeoutSeconds), { stdin: `${config}\n`, timeoutMs: (timeoutSeconds + 10) * 1000 });
    } catch (error) {
      // Too much output is an answer from inside, not an interrupted Docker step.
      if (error.code === 'command_output_too_large') {
        throw unreadableAnswer('answered with more data than the host accepts');
      }
      // No Docker step was interrupted here, so this must not look like one to a rollback.
      if (EXEC_INTERRUPTED_CODES.includes(error.code)) {
        throw new SpaceError('gatekeeper_unreachable', `The request to the gatekeeper did not finish in time: ${error.message}`, { curlExitCode: null, execFailed: false });
      }
      throw error;
    }
    if (result.code !== 0) {
      throw new SpaceError(
        'gatekeeper_unreachable',
        `The gatekeeper of the space did not answer: ${tail(result.stderr) || `curl exit code ${result.code}`}`,
        { curlExitCode: result.code, execFailed: EXEC_FAILED_CODES.includes(result.code) && !isFromCurl(result.stderr) },
      );
    }
    return parseResponse(result.stdout, unreadableAnswer);
  };

  /** A control request that must succeed. Anything but 200 is a refusal the caller must see. */
  const command = async (spaceId, path, body, what) => {
    const answer = await request(spaceId, { method: 'POST', path, body: JSON.stringify(body) });
    if (answer.status !== 200) {
      throw new SpaceError('gatekeeper_refused', `The gatekeeper refused to ${what}: ${tail(answer.body) || `status ${answer.status}`}`, { status: answer.status });
    }
  };

  /**
   * Resolves when the control listener answers, which it does only after the corridor and the
   * window accept connections. The wait ends at a wall-clock deadline whatever happens inside.
   */
  const waitUntilReady = async (spaceId) => {
    const started = now();
    let last = 'no answer yet';
    for (let attempt = 0; attempt < READY_MAX_ATTEMPTS && now() - started < READY_TIMEOUT_MS; attempt += 1) {
      try {
        const answer = await request(spaceId, { path: '/health', timeoutSeconds: HEALTH_SECONDS });
        if (answer.status === 200) {
          return;
        }
        last = `the control channel answered ${answer.status}`;
      } catch (error) {
        const fromInside = error.code === 'gatekeeper_answer_unreadable'
          || (error.code === 'gatekeeper_unreachable' && error.details?.execFailed !== true);
        if (!fromInside) {
          throw error;
        }
        last = error.message;
      }
      await wait(READY_PAUSE_MS);
    }
    throw new SpaceError(
      'gatekeeper_not_ready',
      `The gatekeeper of the space did not become ready within ${Math.round((now() - started) / 1000)} seconds (${last}). Look at the output of its container.`,
    );
  };

  /**
   * The network mode and the allowlist, live. A gatekeeper that was just started allows nothing
   * until this call, so a space never reaches further than the host last said it may.
   */
  const setNetwork = (spaceId, { mode, domains = [] }) => command(spaceId, '/network', { mode, domains }, 'change the network of this space');

  /** One "uses without seeing" grant. The secret is in the body, so it stays out of every argument list. */
  const addGrant = (spaceId, { id, upstream, header, secret }) => command(spaceId, '/grants', { id, upstream, header, secret }, `add the grant '${id}'`);

  /**
   * What the gatekeeper allowed and refused. The answer comes out of a container, so it is read
   * as data: known fields only, capped in count and in length, and never trusted to be complete.
   * `dropped` says how many records the ring buffer has thrown away.
   */
  const readJournal = async (spaceId) => {
    const answer = await request(spaceId, { path: '/journal' });
    if (answer.status !== 200) {
      throw unreadableAnswer(`answered ${answer.status} for its journal`);
    }
    if (answer.body.length > MAX_JOURNAL_BODY_CHARACTERS) {
      throw unreadableAnswer(`answered with a journal of ${answer.body.length} characters, more than the ${MAX_JOURNAL_BODY_CHARACTERS} the host reads`);
    }
    let parsed;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw unreadableAnswer('answered with a journal that is not JSON');
    }
    if (!parsed || !Array.isArray(parsed.records)) {
      throw unreadableAnswer('answered with a journal that holds no records');
    }
    return {
      records: parsed.records.slice(0, MAX_JOURNAL_RECORDS).map((entry) => {
        // Only an object has our fields. A string or a list would answer `at` with a method of its own.
        const record = entry instanceof Object && !Array.isArray(entry) ? entry : {};
        return {
          at: text(record.at),
          listener: text(record.listener),
          host: text(record.host),
          port: Number.isSafeInteger(record.port) ? record.port : 0,
          decision: text(record.decision),
        };
      }),
      dropped: Number.isSafeInteger(parsed.dropped) && parsed.dropped >= 0 ? parsed.dropped : 0,
      // When the gatekeeper started: the journal holds nothing older, and the UI has to say so.
      since: text(parsed.since),
    };
  };

  return { writeProgram, waitUntilReady, setNetwork, addGrant, readJournal };
}
