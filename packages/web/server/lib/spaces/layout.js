
import { SpaceError } from './errors.js';
import { requireSpaceId } from './labels.js';

export const SPACE_USER = '1000:1000';
export const SPACE_HOME = '/home/space';

export const spaceWorkPath = (spaceId) => `/spaces/${requireSpaceId(spaceId)}`;

const PROJECT_FOLDER_UNSAFE = /[^A-Za-z0-9._-]+/g;
const PROJECT_FOLDER_MAX_LENGTH = 64;
const PROJECT_FOLDER_FALLBACK = 'project';

export function projectFolderName(projectDirectory) {
  const base = String(projectDirectory ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? '';
  const name = base.replace(PROJECT_FOLDER_UNSAFE, '-').replace(/^[.-]+/, '').slice(0, PROJECT_FOLDER_MAX_LENGTH);
  if (!/[A-Za-z0-9]/.test(name) || name.toLowerCase() === 'node_modules') {
    return PROJECT_FOLDER_FALLBACK;
  }
  return name;
}

export const spaceProjectPath = (spaceId, projectDirectory) => `${spaceWorkPath(spaceId)}/${projectFolderName(projectDirectory)}`;

export function requireSpaceProjectPath(spaceId, value) {
  const text = String(value ?? '');
  const prefix = `${spaceWorkPath(spaceId)}/`;
  const name = text.slice(prefix.length);
  if (!text.startsWith(prefix) || name === '' || projectFolderName(name) !== name) {
    throw new SpaceError('invalid_space_path', `A project path in space ${spaceId} is ${prefix}<folder>, the spacePath that code in returned`);
  }
  return text;
}

export const spaceHistoryPath = (spaceId) => `${spaceWorkPath(spaceId)}/.openchamber-history.git`;

export const TOOLS_MOUNT_PATH = '/opt/openchamber-tools';
export const TOOLS_BIN_PATH = `${TOOLS_MOUNT_PATH}/node_modules/.bin`;
export const TOOLS_PLUGIN_PATH = `${TOOLS_MOUNT_PATH}/node_modules/@opencode/plugin`;
export const TOOLS_MARKER_PATH = `${TOOLS_MOUNT_PATH}/.filled`;

export const SPACE_SERVER_HOST = '127.0.0.1';
export const SPACE_SERVER_PORT = 27600;

export const SPACE_TOKEN_DIRECTORY = `${SPACE_HOME}/.openchamber-space`;
export const SPACE_TOKEN_PATH = `${SPACE_TOKEN_DIRECTORY}/token`;
export const SPACE_IDLE_STOP_PATH = `${SPACE_TOKEN_DIRECTORY}/idle-stop.json`;
export const SPACE_IDLE_EXIT_CODE = 75;
export const SPACE_PERMISSION_DEFAULT_PATH = `${SPACE_TOKEN_DIRECTORY}/permission-default.json`;
const SPACE_AGENT_TASK_TITLE_PATH = `${SPACE_TOKEN_DIRECTORY}/task-title.json`;
export const SPACE_USER_TASK_TITLE_PATH = `${SPACE_TOKEN_DIRECTORY}/user-task-title.json`;

export const GATEKEEPER_ALIAS = 'gatekeeper';
export const GATEKEEPER_CORRIDOR_PORT = 3128;
export const GATEKEEPER_WINDOW_PORT = 8080;
export const GATEKEEPER_CONTROL_HOST = '127.0.0.1';
export const GATEKEEPER_CONTROL_PORT = 9099;

const GATEKEEPER_CORRIDOR_URL = `http://${GATEKEEPER_ALIAS}:${GATEKEEPER_CORRIDOR_PORT}`;
export const spaceWindowUrl = (grantId) => `http://${GATEKEEPER_ALIAS}:${GATEKEEPER_WINDOW_PORT}/model/${grantId}`;

export const GATEKEEPER_PROGRAM_DIRECTORY = '/tmp/openchamber-gatekeeper';
export const GATEKEEPER_PROGRAM_PATH = `${GATEKEEPER_PROGRAM_DIRECTORY}/gatekeeper.cjs`;
export const GATEKEEPER_BIND_PATH = `${GATEKEEPER_PROGRAM_DIRECTORY}/bind`;

export const spaceOpenCodeConfigDirectory = (spaceId) => `${spaceWorkPath(spaceId)}/.opencode`;
export const spaceOpenCodeConfigPath = (spaceId) => `${spaceOpenCodeConfigDirectory(spaceId)}/opencode.json`;
export const LEGACY_SPACE_OPENCODE_CONFIG_PATH = `${SPACE_HOME}/.config/opencode/opencode.json`;

const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export const IMAGE_SH = '/bin/sh';
export const IMAGE_CAT = '/bin/cat';
export const IMAGE_CHOWN = '/bin/chown';
export const IMAGE_CURL = '/usr/bin/curl';
export const IMAGE_NODE = '/usr/local/bin/node';
export const IMAGE_BASH = '/bin/bash';
const IMAGE_SLEEP = '/bin/sleep';
export const IMAGE_GIT = '/usr/bin/git';
export const IMAGE_TIMEOUT = '/usr/bin/timeout';

export const IMAGE_ONLY_PATH = `PATH=${IMAGE_PATH};`;

export const SPACE_ENVIRONMENT = Object.freeze({
  HOME: SPACE_HOME,
  PATH: `${IMAGE_PATH}:${TOOLS_BIN_PATH}`,
  // external: https://everything.curl.dev/usingcurl/proxies/env.html curl ignores uppercase HTTP_PROXY for httpoxy protection.
  HTTPS_PROXY: GATEKEEPER_CORRIDOR_URL,
  https_proxy: GATEKEEPER_CORRIDOR_URL,
  HTTP_PROXY: GATEKEEPER_CORRIDOR_URL,
  http_proxy: GATEKEEPER_CORRIDOR_URL,
  NO_PROXY: `${GATEKEEPER_ALIAS},localhost,127.0.0.1`,
  no_proxy: `${GATEKEEPER_ALIAS},localhost,127.0.0.1`,
  // external: https://nodejs.org/api/cli.html#node_use_env_proxy1 Node needs NODE_USE_ENV_PROXY to honor proxy environment variables.
  NODE_USE_ENV_PROXY: '1',
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCHAMBER_RELAY_HOST: 'off',
  OPENCHAMBER_SPACE_IDLE_STOP_FILE: SPACE_IDLE_STOP_PATH,
  OPENCHAMBER_SPACE_PERMISSION_DEFAULT_FILE: SPACE_PERMISSION_DEFAULT_PATH,
  OPENCHAMBER_SPACE_TASK_TITLE_FILE: SPACE_AGENT_TASK_TITLE_PATH,
  OPENCHAMBER_SPACE_USER_TASK_TITLE_FILE: SPACE_USER_TASK_TITLE_PATH,
});

const SERVER_SCRIPT = [
  `while [ ! -s ${SPACE_TOKEN_PATH} ]; do ${IMAGE_SLEEP} 0.2; done;`,
  `OPENCHAMBER_UI_PASSWORD="$(${IMAGE_CAT} ${SPACE_TOKEN_PATH})";`,
  'export OPENCHAMBER_UI_PASSWORD;',
  `exec openchamber serve --foreground --api-only --host ${SPACE_SERVER_HOST} --port ${SPACE_SERVER_PORT}`,
].join(' ');

export const SPACE_SERVER_COMMAND = Object.freeze([IMAGE_SH, '-c', SERVER_SCRIPT]);

export const CONNECT_BRIDGE_PROGRAM = [
  'const net = require("node:net");',
  'const [host, port] = process.argv.slice(1);',
  'const socket = net.connect({ host, port: Number(port) });',
  'const leave = (code) => process.stdout.write("", () => process.exit(code));',
  'socket.on("error", (error) => { process.stderr.write(String(error.code || error.message)); leave(1); });',
  'socket.on("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout, { end: false }); });',
  'socket.on("close", () => leave(0));',
  'process.stdin.on("error", () => socket.destroy());',
  'process.stdout.on("error", () => socket.destroy());',
].join(' ');

export const SPACE_CONNECT_COMMAND = Object.freeze([IMAGE_NODE, '-e', CONNECT_BRIDGE_PROGRAM, SPACE_SERVER_HOST, String(SPACE_SERVER_PORT)]);

export const GATEKEEPER_ENVIRONMENT = Object.freeze({ HOME: '/tmp' });

const GATEKEEPER_WINDOW_DEADLINE_MS = 300_000;

const GATEKEEPER_CORRIDOR_CONNECTIONS = 128;
const GATEKEEPER_WINDOW_CONNECTIONS = 64;
const GATEKEEPER_CONTROL_CONNECTIONS = 8;

const GATEKEEPER_SCRIPT = [
  `while [ ! -s ${GATEKEEPER_PROGRAM_PATH} ]; do ${IMAGE_SLEEP} 0.2; done;`,
  `exec ${IMAGE_NODE} ${GATEKEEPER_PROGRAM_PATH}`,
  GATEKEEPER_BIND_PATH,
  String(GATEKEEPER_CORRIDOR_PORT),
  String(GATEKEEPER_WINDOW_PORT),
  String(GATEKEEPER_CONTROL_PORT),
  String(GATEKEEPER_WINDOW_DEADLINE_MS),
  String(GATEKEEPER_CORRIDOR_CONNECTIONS),
  String(GATEKEEPER_WINDOW_CONNECTIONS),
  String(GATEKEEPER_CONTROL_CONNECTIONS),
].join(' ');

export const GATEKEEPER_COMMAND = Object.freeze([IMAGE_SH, '-c', GATEKEEPER_SCRIPT]);
