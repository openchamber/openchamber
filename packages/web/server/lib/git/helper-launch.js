/**
 * How Git reaches one of this module's helper scripts.
 *
 * Git runs a credential helper or `GIT_SSH_COMMAND` through `sh`, so the
 * helper is named as a shell command. The server's own executable runs the
 * script: under Bun or Node that is the executable itself, but the desktop
 * app is Electron, whose binary starts another copy of the app unless it is
 * told to behave as Node. The prefix travels inside the command, so the
 * helper works wherever the command ends up, including a repository's own
 * `.git/config`, where no environment of ours is present.
 */

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// `process.versions.electron` is set only when Electron is the host.
const runsAsElectron = (versions = process.versions) => Boolean(versions?.electron);

/** `[ELECTRON_RUN_AS_NODE=1 ]'<executable>' '<script>' '<arg>'...` */
export const helperShellCommand = (scriptPath, args = [], { execPath = process.execPath, versions = process.versions } = {}) => {
  const prefix = runsAsElectron(versions) ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${prefix}${[execPath, scriptPath, ...args].map(shellQuote).join(' ')}`;
};

/** Environment for spawning a helper script directly, without a shell. */
export const helperSpawnEnv = (base = process.env, { versions = process.versions } = {}) => (runsAsElectron(versions)
  ? { ...base, ELECTRON_RUN_AS_NODE: '1' }
  : { ...base });
