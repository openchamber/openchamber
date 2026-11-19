
import crypto from 'node:crypto';
import type { SpaceExec } from './command-contracts.js';
import type { ExecHttpResponse } from './exec-http.js';
import type { IdleStopSetting } from './idle-stop.js';
import type { permissionDefaultOf } from './space-permission-default.js';
import { requiredFailureProperty as failureProperty, failureProperty as optionalFailureProperty } from './failure.js';

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
import {
  IMAGE_CAT,
  IMAGE_ONLY_PATH,
  IMAGE_SH,
  SPACE_IDLE_STOP_PATH,
  SPACE_PERMISSION_DEFAULT_PATH,
  SPACE_USER_TASK_TITLE_PATH,
  SPACE_SERVER_HOST,
  SPACE_SERVER_PORT,
  SPACE_TOKEN_DIRECTORY,
  SPACE_TOKEN_PATH,
  TOOLS_PLUGIN_PATH,
  spaceWorkPath,
} from './layout.js';

const REQUEST_SECONDS = 20;
const HEALTH_SECONDS = 3;
const READY_TIMEOUT_MS = 120_000;
const READY_PAUSE_MS = 500;
const READY_MAX_ATTEMPTS = 1_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const READ_TOKEN_TIMEOUT_MS = 10_000;

const WRITE_TOKEN_SCRIPT = [
  IMAGE_ONLY_PATH,
  'umask 077;',
  `mkdir -p ${SPACE_TOKEN_DIRECTORY} && chmod 700 ${SPACE_TOKEN_DIRECTORY}`,
  `&& cat > ${SPACE_TOKEN_PATH}.new && mv ${SPACE_TOKEN_PATH}.new ${SPACE_TOKEN_PATH}`,
].join(' ');

const writeSettingScript = (filePath: string) => [
  IMAGE_ONLY_PATH,
  'umask 077;',
  `mkdir -p ${SPACE_TOKEN_DIRECTORY} && chmod 700 ${SPACE_TOKEN_DIRECTORY}`,
  `&& cat > ${filePath}.new && mv ${filePath}.new ${filePath}`,
].join(' ');
const WRITE_IDLE_STOP_SCRIPT = writeSettingScript(SPACE_IDLE_STOP_PATH);
const WRITE_PERMISSION_DEFAULT_SCRIPT = writeSettingScript(SPACE_PERMISSION_DEFAULT_PATH);
const WRITE_USER_TASK_TITLE_SCRIPT = writeSettingScript(SPACE_USER_TASK_TITLE_PATH);

const LINK_PLUGIN_SCRIPT = `${IMAGE_ONLY_PATH} mkdir -p "$1/node_modules/@opencode" && ln -sfn "$2" "$1/node_modules/@opencode/plugin"`;

const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

export const createSpaceToken = () => crypto.randomBytes(32).toString('base64url');

const unreadableAnswer = (why: string) => new SpaceError('space_server_answer_unreadable', `The server inside the space ${why}`);

const MAX_HEALTH_BODY_CHARACTERS = 64 * 1024;

const reportsReady = (answer: ExecHttpResponse) => {
  if (answer.status !== 200 || answer.body.length > MAX_HEALTH_BODY_CHARACTERS) {
    return false;
  }
  try {
    return JSON.parse(answer.body)?.isOpenCodeReady === true;
  } catch {
    return false;
  }
};

export interface SpaceServerRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutSeconds?: number;
}

interface ReadinessReport {
  last: unknown;
}

export function createSpaceServerChannel({ exec, wait = pause, now = Date.now }: { exec: SpaceExec; wait?: (milliseconds: number) => Promise<void>; now?: () => number }) {
  const runFixedScript = async (spaceId: string, argv: string[], stdin: string, what: string) => {
    const result = await exec(spaceId, argv, { stdin });
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not ${what} inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
    return result.stdout;
  };

  const writeToken = (spaceId: string, token: string) => runFixedScript(spaceId, [IMAGE_SH, '-c', WRITE_TOKEN_SCRIPT], token, 'store the server token');

  const writeIdleStop = (spaceId: string, setting: IdleStopSetting) => runFixedScript(spaceId, [IMAGE_SH, '-c', WRITE_IDLE_STOP_SCRIPT], JSON.stringify(setting), 'store the idle stop setting');

  const writePermissionDefault = (spaceId: string, setting: ReturnType<typeof permissionDefaultOf>) => runFixedScript(spaceId, [IMAGE_SH, '-c', WRITE_PERMISSION_DEFAULT_SCRIPT], JSON.stringify(setting), 'store the default permission mode');
  const writeUserTaskTitle = (spaceId: string, setting: { title: string }) => runFixedScript(spaceId, [IMAGE_SH, '-c', WRITE_USER_TASK_TITLE_SCRIPT], JSON.stringify(setting), 'store the user task title');

  const readToken = async (spaceId: string) => {
    const unreadable = (why: string) => new SpaceError('space_token_unreadable', `The token file of the server inside the space ${why}. Something inside the space changed it.`);
    let result;
    try {
      result = await exec(spaceId, [IMAGE_CAT, SPACE_TOKEN_PATH], { stdin: '', timeoutMs: READ_TOKEN_TIMEOUT_MS });
    } catch (error) {
      if (failureProperty(error, 'code') === 'command_output_too_large') throw unreadable('is far too large');
      if (EXEC_INTERRUPTED_CODES.some((code) => code === failureProperty(error, 'code'))) throw unreadable('could not be read in time');
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

  const linkPlugin = (spaceId: string) => runFixedScript(spaceId, [IMAGE_SH, '-c', LINK_PLUGIN_SCRIPT, 'sh', spaceWorkPath(spaceId), TOOLS_PLUGIN_PATH], '', 'link the OpenCode plugin');

  const request = async (spaceId: string, { method = 'GET', path, headers = {}, body = null, timeoutSeconds = REQUEST_SECONDS }: SpaceServerRequest) => {
    const config = buildCurlConfig({ url: `http://${SPACE_SERVER_HOST}:${SPACE_SERVER_PORT}${path}`, method, headers, body });
    let result;
    try {
      result = await exec(
        spaceId,
        buildCurlArgs(timeoutSeconds),
        { stdin: `${config}\n`, timeoutMs: (timeoutSeconds + 10) * 1000 },
      );
    } catch (error) {
      if (failureProperty(error, 'code') === 'command_output_too_large') {
        throw unreadableAnswer('answered with more data than the host accepts');
      }
      if (EXEC_INTERRUPTED_CODES.some((code) => code === failureProperty(error, 'code'))) {
        throw new SpaceError('space_server_unreachable', `The request to the server inside the space did not finish in time: ${failureProperty(error, 'message')}`, { curlExitCode: null, execFailed: false });
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
    return parseResponse(result.stdout, unreadableAnswer);
  };

  const waitUntilReady = async (spaceId: string) => {
    const started = now();
    const report: ReadinessReport = { last: 'no answer yet' };
    for (let attempt = 0; attempt < READY_MAX_ATTEMPTS && now() - started < READY_TIMEOUT_MS; attempt += 1) {
      try {
        if (reportsReady(await request(spaceId, { path: '/health', timeoutSeconds: HEALTH_SECONDS }))) {
          return;
        }
        report.last = 'the answer does not report OpenCode ready';
      } catch (error) {
        const fromInside = failureProperty(error, 'code') === 'space_server_answer_unreadable'
          || (failureProperty(error, 'code') === 'space_server_unreachable' && optionalFailureProperty(failureProperty(error, 'details'), 'execFailed') !== true);
        if (!fromInside) {
          throw error;
        }
        report.last = failureProperty(error, 'message');
      }
      await wait(READY_PAUSE_MS);
    }
    throw new SpaceError(
      'space_server_not_ready',
      `The server inside the space did not become ready within ${Math.round((now() - started) / 1000)} seconds (${report.last}). Look at the output of the space container, and check that the space has enough memory.`,
    );
  };

  return { writeToken, writeIdleStop, writePermissionDefault, writeUserTaskTitle, readToken, linkPlugin, request, waitUntilReady };
}
