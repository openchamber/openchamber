
import { readFileSync } from 'node:fs';
import net from 'node:net';

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
  GATEKEEPER_BIND_PATH,
  GATEKEEPER_CONTROL_HOST,
  GATEKEEPER_CONTROL_PORT,
  GATEKEEPER_PROGRAM_DIRECTORY,
  GATEKEEPER_PROGRAM_PATH,
  IMAGE_ONLY_PATH,
  IMAGE_SH,
} from './layout.js';

export const GATEKEEPER_PROGRAM = readFileSync(new URL('./gatekeeper-program.cjs', import.meta.url), 'utf8');

const REQUEST_SECONDS = 20;
const HEALTH_SECONDS = 3;
const READY_TIMEOUT_MS = 60_000;
const READY_PAUSE_MS = 250;
const READY_MAX_ATTEMPTS = 1_000;

const MAX_JOURNAL_RECORDS = 1_000;
const MAX_JOURNAL_BODY_CHARACTERS = 1024 * 1024;
const MAX_JOURNAL_FIELD_CHARACTERS = 256;

const WRITE_PROGRAM_SCRIPT = [
  IMAGE_ONLY_PATH,
  `mkdir -p ${GATEKEEPER_PROGRAM_DIRECTORY}`,
  `&& printf '%s' "$1" > ${GATEKEEPER_BIND_PATH}.new && mv ${GATEKEEPER_BIND_PATH}.new ${GATEKEEPER_BIND_PATH}`,
  `&& cat > ${GATEKEEPER_PROGRAM_PATH}.new && mv ${GATEKEEPER_PROGRAM_PATH}.new ${GATEKEEPER_PROGRAM_PATH}`,
].join(' ');

const MAX_POLICY_BODY_CHARACTERS = 256 * 1024;
const MAX_POLICY_ENTRIES = 1_000;

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

const unreadableAnswer = (why) => new SpaceError('gatekeeper_answer_unreadable', `The network filter of the space ${why}`);

const text = (value) => (value === null || value === undefined || value instanceof Object ? '' : String(value).slice(0, MAX_JOURNAL_FIELD_CHARACTERS));

export function createGatekeeperChannel({ exec, wait = pause, now = Date.now }) {
  const execInGatekeeper = (spaceId, argv, options) => exec(spaceId, argv, { ...options, target: ROLE_GATEKEEPER });

  const writeProgram = async (spaceId, { bindAddress }) => {
    if (net.isIP(bindAddress) === 0 || bindAddress === '0.0.0.0' || bindAddress === '::') {
      throw new SpaceError('gatekeeper_address_unknown', 'The address of the network filter on the space\'s network is not known, so its listeners cannot be bound to it.');
    }
    const result = await execInGatekeeper(spaceId, [IMAGE_SH, '-c', WRITE_PROGRAM_SCRIPT, 'sh', bindAddress], { stdin: GATEKEEPER_PROGRAM });
    if (result.code !== 0) {
      throw new SpaceError('gatekeeper_setup_failed', `Could not store the network filter's program: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
  };

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
      if (error.code === 'command_output_too_large') {
        throw unreadableAnswer('answered with more data than the host accepts');
      }
      if (EXEC_INTERRUPTED_CODES.includes(error.code)) {
        throw new SpaceError('gatekeeper_unreachable', `The request to the network filter did not finish in time: ${error.message}`, { curlExitCode: null, execFailed: false });
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

  const command = async (spaceId, path, body, what) => {
    const answer = await request(spaceId, { method: 'POST', path, body: JSON.stringify(body) });
    if (answer.status !== 200) {
      throw new SpaceError('gatekeeper_refused', `The network filter refused to ${what}: ${tail(answer.body) || `status ${answer.status}`}`, { status: answer.status });
    }
  };

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

  const setNetwork = (spaceId, { mode, domains = [] }) => command(spaceId, '/network', { mode, domains }, 'change the network of this space');

  const addGrant = (spaceId, { id, upstream, header = null, secret = null, headers = {} }) => {
    const body = { id, upstream };
    if (secret !== null) Object.assign(body, { header, secret });
    if (Object.keys(headers).length > 0) body.headers = headers;
    return command(spaceId, '/grants', body, `add the grant '${id}'`);
  };

  const readPolicy = async (spaceId) => {
    const answer = await request(spaceId, { path: '/policy' });
    if (answer.status !== 200) throw unreadableAnswer(`answered ${answer.status} for its policy`);
    if (answer.body.length > MAX_POLICY_BODY_CHARACTERS) throw unreadableAnswer('answered with a policy larger than the host reads');
    let parsed;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw unreadableAnswer('answered with a policy that is not JSON');
    }
    if (!(parsed instanceof Object) || Array.isArray(parsed) || !Array.isArray(parsed.grants) || !Array.isArray(parsed.domains)) {
      throw unreadableAnswer('answered with a policy that holds no lists');
    }
    const names = (list) => list.slice(0, MAX_POLICY_ENTRIES).map(text).filter((entry) => entry !== '');
    return {
      mode: parsed.mode === 'open' ? 'open' : 'allowlist',
      domains: names(parsed.domains),
      grants: names(parsed.grants),
    };
  };

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
      since: text(parsed.since),
    };
  };

  return { writeProgram, waitUntilReady, setNetwork, addGrant, readPolicy, readJournal };
}
