// What a space looks like from the inside. Every place builds its container from these
// facts, and everything written on top of `exec` relies on them.

import { SpaceError } from './errors.js';
import { requireSpaceId } from './labels.js';

export const SPACE_USER = '1000:1000';
export const SPACE_HOME = '/home/space';

export const spaceWorkPath = (spaceId) => `/spaces/${requireSpaceId(spaceId)}`;

// The project's folder inside a space is named after the project directory on the host, restricted
// to characters that need no quoting anywhere. A leading dot is refused, so the name never collides
// with the history side repository below, and `node_modules` is refused because the OpenCode plugin
// link lives at `/spaces/<id>/node_modules`.
const PROJECT_FOLDER_UNSAFE = /[^A-Za-z0-9._-]+/g;
const PROJECT_FOLDER_MAX_LENGTH = 64;
const PROJECT_FOLDER_FALLBACK = 'project';

/** The folder name of a project inside a space, derived from the base name of its directory on the host. */
export function projectFolderName(projectDirectory) {
  const base = String(projectDirectory ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? '';
  const name = base.replace(PROJECT_FOLDER_UNSAFE, '-').replace(/^[.-]+/, '').slice(0, PROJECT_FOLDER_MAX_LENGTH);
  if (!/[A-Za-z0-9]/.test(name) || name.toLowerCase() === 'node_modules') {
    return PROJECT_FOLDER_FALLBACK;
  }
  return name;
}

/** Where the project's code lives inside a space: a plain non-bare repository. */
export const spaceProjectPath = (spaceId, projectDirectory) => `${spaceWorkPath(spaceId)}/${projectFolderName(projectDirectory)}`;

/** A project path of this space, one folder deep with a name the rule above could have made, or a refusal. */
export function requireSpaceProjectPath(spaceId, value) {
  const text = String(value ?? '');
  const prefix = `${spaceWorkPath(spaceId)}/`;
  const name = text.slice(prefix.length);
  if (!text.startsWith(prefix) || name === '' || projectFolderName(name) !== name) {
    throw new SpaceError('invalid_space_path', `A project path in space ${spaceId} is ${prefix}<folder>, the spacePath that code in returned`);
  }
  return text;
}

// The side repository that the history travels through. It starts with a dot, which no project
// folder name can, and it exists only while the history is on its way.
export const spaceHistoryPath = (spaceId) => `${spaceWorkPath(spaceId)}/.openchamber-history.git`;

// The tools volume: a plain npm project, mounted read-only.
export const TOOLS_MOUNT_PATH = '/opt/openchamber-tools';
export const TOOLS_BIN_PATH = `${TOOLS_MOUNT_PATH}/node_modules/.bin`;
export const TOOLS_PLUGIN_PATH = `${TOOLS_MOUNT_PATH}/node_modules/@opencode/plugin`;
// The filler writes this file last. A volume without it was never filled to the end.
export const TOOLS_MARKER_PATH = `${TOOLS_MOUNT_PATH}/.filled`;

// The server inside listens on loopback only, so nothing faces the space network.
// The port is an unusual one, because the agent's own dev servers share this loopback.
export const SPACE_SERVER_HOST = '127.0.0.1';
export const SPACE_SERVER_PORT = 27600;

export const SPACE_TOKEN_DIRECTORY = `${SPACE_HOME}/.openchamber-space`;
export const SPACE_TOKEN_PATH = `${SPACE_TOKEN_DIRECTORY}/token`;

// The gatekeeper, the space's only way out. It sits on the space's internal network under this
// name and on the space's own outer network, and nothing else joins either of them.
export const GATEKEEPER_ALIAS = 'gatekeeper';
// The two listeners the space may see. They bind every interface of the gatekeeper, because
// the space's network is the point of them.
const GATEKEEPER_BIND_HOST = '0.0.0.0';
export const GATEKEEPER_CORRIDOR_PORT = 3128;
export const GATEKEEPER_WINDOW_PORT = 8080;
// The control channel. It binds the gatekeeper's own loopback, so only an `exec` from the host
// reaches it. Measured on Docker 29.2.1: a listener on 127.0.0.1 in a container is refused from
// another container on the same network, while the same listener on 0.0.0.0 answers.
export const GATEKEEPER_CONTROL_HOST = '127.0.0.1';
export const GATEKEEPER_CONTROL_PORT = 9099;

// Where the space sends its traffic. The window's own URL, `http://gatekeeper:8080/model/<grant>`,
// belongs to whoever writes a provider configuration, which no stage does yet.
const GATEKEEPER_CORRIDOR_URL = `http://${GATEKEEPER_ALIAS}:${GATEKEEPER_CORRIDOR_PORT}`;

// The gatekeeper's program arrives over `exec` on stdin, into the container's tmpfs. It is far
// larger than the tools filler, and a `node -e` argument of that size was never tried on Windows.
export const GATEKEEPER_PROGRAM_DIRECTORY = '/tmp/openchamber-gatekeeper';
export const GATEKEEPER_PROGRAM_PATH = `${GATEKEEPER_PROGRAM_DIRECTORY}/gatekeeper.cjs`;

const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// The programs of the base image that the host runs inside a container, by absolute path,
// so that no PATH decides what the host runs.
// Verified in the pinned image with `command -v`: `/bin` is a link to `/usr/bin`.
export const IMAGE_SH = '/bin/sh';
export const IMAGE_CAT = '/bin/cat';
export const IMAGE_CHOWN = '/bin/chown';
export const IMAGE_CURL = '/usr/bin/curl';
export const IMAGE_NODE = '/usr/local/bin/node';
const IMAGE_SLEEP = '/bin/sleep';
// Code in: the receiving side of a push runs as `timeout -s KILL <seconds> git receive-pack <path>`.
// The image's git is 2.39.5, and it has no `pkill`.
export const IMAGE_GIT = '/usr/bin/git';
export const IMAGE_TIMEOUT = '/usr/bin/timeout';

/** First line of every fixed script the host runs inside: its commands come from the image only. */
export const IMAGE_ONLY_PATH = `PATH=${IMAGE_PATH};`;

/**
 * The environment of a space. Neither the password of the server inside nor any credential ever
 * goes here: container env is readable through `inspect`, and the hardening check allows no
 * variable beyond these and the base image's own.
 */
export const SPACE_ENVIRONMENT = Object.freeze({
  HOME: SPACE_HOME,
  // The tools come last. The image has no `openchamber` and no `opencode`, so both are still found,
  // and a transitive npm package that ships a bin named `node` or `sh` never shadows the image's.
  PATH: `${IMAGE_PATH}:${TOOLS_BIN_PATH}`,
  // The corridor, in both spellings. curl 7.88.1 in this image ignores an uppercase HTTP_PROXY on
  // purpose, the httpoxy protection, and honours the lowercase one. Without the lowercase spelling
  // plain-HTTP traffic from curl and from everything that uses libcurl never reaches the corridor.
  HTTPS_PROXY: GATEKEEPER_CORRIDOR_URL,
  https_proxy: GATEKEEPER_CORRIDOR_URL,
  HTTP_PROXY: GATEKEEPER_CORRIDOR_URL,
  http_proxy: GATEKEEPER_CORRIDOR_URL,
  // Window traffic skips the corridor, and so does the space's own loopback. Measured: with
  // http_proxy set, curl sends even http://127.0.0.1 to the corridor, and Node with
  // NODE_USE_ENV_PROXY=1 proxies loopback too. Both spellings, because curl reads both.
  NO_PROXY: `${GATEKEEPER_ALIAS},localhost,127.0.0.1`,
  no_proxy: `${GATEKEEPER_ALIAS},localhost,127.0.0.1`,
  // Node 22 ignores proxy variables without this. Measured: EAI_AGAIN for every fetch.
  NODE_USE_ENV_PROXY: '1',
  // OpenCode's catalog and update downloads would only spend corridor attempts.
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  // The server inside a space never hosts the relay passively. It has a way out now, and a
  // space must not become the machine that paired devices land on.
  OPENCHAMBER_RELAY_HOST: 'off',
});

// Waits for the token file, takes it as the server password, and becomes the server.
// The password reaches the server through the environment of this one process, never through the container's.
const SERVER_SCRIPT = [
  `while [ ! -s ${SPACE_TOKEN_PATH} ]; do ${IMAGE_SLEEP} 0.2; done;`,
  `OPENCHAMBER_UI_PASSWORD="$(${IMAGE_CAT} ${SPACE_TOKEN_PATH})";`,
  'export OPENCHAMBER_UI_PASSWORD;',
  `exec openchamber serve --foreground --api-only --host ${SPACE_SERVER_HOST} --port ${SPACE_SERVER_PORT}`,
].join(' ');

/** The command of a space container. A fixed script, nothing in it varies per space. */
export const SPACE_SERVER_COMMAND = Object.freeze([IMAGE_SH, '-c', SERVER_SCRIPT]);

// The bridge of `connect`: runs inside the space over `docker exec --interactive`, joins its stdin
// and stdout to the loopback port of the server inside, and ends when either side ends. It
// leaves only after its last write to stdout has gone out: an exit on the socket's close would
// drop what is still buffered. The two standard streams are Node's own, which cope with a pipe
// that is full; a plain file stream on the descriptor failed with a system error there,
// measured on macOS with a four-megabyte answer. One line, as every fixed program that travels
// as an argument. It uses `net`, which no proxy variable of the space touches, and reads nothing
// from the space but its two arguments.
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

/** The command that `connect` runs inside a space: the bridge to the server inside, on the image's Node. */
export const SPACE_CONNECT_COMMAND = Object.freeze([IMAGE_NODE, '-e', CONNECT_BRIDGE_PROGRAM, SPACE_SERVER_HOST, String(SPACE_SERVER_PORT)]);

/**
 * The environment of a gatekeeper. It holds no secret and never will: grants arrive on the
 * stdin of an `exec` and live in the program's memory. HOME points into the tmpfs, because the
 * root filesystem is read-only and a program that resolves HOME must land somewhere writable.
 */
export const GATEKEEPER_ENVIRONMENT = Object.freeze({ HOME: '/tmp' });

// How long the window waits for an upstream that has gone quiet. The same as the corridor's
// tunnel idle limit, and for the same reason: a model answer streams, so silence is what counts.
const GATEKEEPER_WINDOW_DEADLINE_MS = 300_000;

// How many connections each listener holds at once. The corridor's is twice the tunnel cap, so
// every handshake a working space makes has room; the window serves one request per connection
// and holds a socket out for each; only the host talks to the control channel.
const GATEKEEPER_CORRIDOR_CONNECTIONS = 128;
const GATEKEEPER_WINDOW_CONNECTIONS = 64;
const GATEKEEPER_CONTROL_CONNECTIONS = 8;

// The same shape as the space's wait for its token: the container comes up, waits for the file
// the host sends over `exec`, and becomes the program. The ports, the deadline and the caps are
// arguments, so the one program serves the container and the tests without a switch that weakens
// it. These numbers are the production ones and the hardening test asserts this whole command.
const GATEKEEPER_SCRIPT = [
  `while [ ! -s ${GATEKEEPER_PROGRAM_PATH} ]; do ${IMAGE_SLEEP} 0.2; done;`,
  `exec ${IMAGE_NODE} ${GATEKEEPER_PROGRAM_PATH}`,
  GATEKEEPER_BIND_HOST,
  String(GATEKEEPER_CORRIDOR_PORT),
  String(GATEKEEPER_WINDOW_PORT),
  String(GATEKEEPER_CONTROL_PORT),
  String(GATEKEEPER_WINDOW_DEADLINE_MS),
  String(GATEKEEPER_CORRIDOR_CONNECTIONS),
  String(GATEKEEPER_WINDOW_CONNECTIONS),
  String(GATEKEEPER_CONTROL_CONNECTIONS),
].join(' ');

/** The command of a gatekeeper container. Fixed, and the same for every space. */
export const GATEKEEPER_COMMAND = Object.freeze([IMAGE_SH, '-c', GATEKEEPER_SCRIPT]);
