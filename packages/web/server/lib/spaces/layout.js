// What a space looks like from the inside. Every place builds its container from these
// facts, and everything written on top of `exec` relies on them.

import { requireSpaceId } from './labels.js';

export const SPACE_USER = '1000:1000';
export const SPACE_HOME = '/home/space';

export const spaceWorkPath = (spaceId) => `/spaces/${requireSpaceId(spaceId)}`;

// The tools volume: a plain npm project, mounted read-only.
export const TOOLS_MOUNT_PATH = '/opt/openchamber-tools';
export const TOOLS_BIN_PATH = `${TOOLS_MOUNT_PATH}/node_modules/.bin`;
export const TOOLS_PLUGIN_PATH = `${TOOLS_MOUNT_PATH}/node_modules/@opencode-ai/plugin`;
// The filler writes this file last. A volume without it was never filled to the end.
export const TOOLS_MARKER_PATH = `${TOOLS_MOUNT_PATH}/.filled`;

// The server inside listens on loopback only, so nothing faces the space network.
// The port is an unusual one, because the agent's own dev servers share this loopback.
export const SPACE_SERVER_HOST = '127.0.0.1';
export const SPACE_SERVER_PORT = 27600;

export const SPACE_TOKEN_DIRECTORY = `${SPACE_HOME}/.openchamber-space`;
export const SPACE_TOKEN_PATH = `${SPACE_TOKEN_DIRECTORY}/token`;

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

/** First line of every fixed script the host runs inside: its commands come from the image only. */
export const IMAGE_ONLY_PATH = `PATH=${IMAGE_PATH};`;

/**
 * The environment of a space. The password of the server inside and
 * OPENCODE_AUTH_CONTENT never go here: container env is readable through `inspect`.
 */
export const SPACE_ENVIRONMENT = Object.freeze({
  HOME: SPACE_HOME,
  // The tools come last. The image has no `openchamber` and no `opencode`, so both are still found,
  // and a transitive npm package that ships a bin named `node` or `sh` never shadows the image's.
  PATH: `${IMAGE_PATH}:${TOOLS_BIN_PATH}`,
  // A space has no way out, so OpenCode's start-up downloads could only fail.
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  // OpenCode installs @opencode-ai/plugin into every config directory and its tool registry waits
  // for that install. Without a network npm retries for about two minutes. With no retries it gives up at once.
  npm_config_fetch_retries: '0',
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
