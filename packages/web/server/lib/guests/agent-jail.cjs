'use strict';

/**
 * Guest agent jail preload. Host spawns with `node -r` / `bun --preload`.
 * Not an OS sandbox: blocks Node child_process and unix/npipe dials that are
 * not on the grant allowlists. Native addons and raw fds can still bypass.
 */

const childProcess = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const parseList = (raw) => {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => entry.trim());
  } catch {
    return [];
  }
};

const jailOn = process.env.OPENCHAMBER_AGENT_JAIL === '1';

/** @type {Set<string>} */
const execAllow = new Set(
  parseList(process.env.OPENCHAMBER_AGENT_EXEC_ALLOW).map((entry) => (
    path.basename(entry).toLowerCase().replace(/\.exe$/i, '')
  )),
);

/** @type {Set<string>} */
const socketAllow = new Set();
for (const entry of parseList(process.env.OPENCHAMBER_AGENT_SOCKET_ALLOW)) {
  socketAllow.add(entry);
  try {
    socketAllow.add(path.resolve(entry));
  } catch {
    // keep raw
  }
}

const denied = (message) => {
  const error = new Error(message);
  error.code = 'OPENCHAMBER_AGENT_JAIL';
  return error;
};

const commandBase = (file) => {
  const value = String(file || '').trim();
  if (!value) {
    return '';
  }
  return path.basename(value).toLowerCase().replace(/\.exe$/i, '');
};

/**
 * @param {unknown} file
 * @param {import('node:child_process').SpawnOptions | undefined} options
 */
const assertExecAllowed = (file, options = {}) => {
  if (options && options.shell) {
    throw denied('Guest agent jail: shell execution is not allowed.');
  }
  const base = commandBase(file);
  if (!base) {
    throw denied('Guest agent jail: missing command.');
  }
  if (!execAllow.has(base)) {
    throw denied(`Guest agent jail: exec "${base}" is not allowlisted.`);
  }
};

/**
 * @param {unknown} socketPath
 */
const assertSocketAllowed = (socketPath) => {
  if (socketPath === undefined || socketPath === null || socketPath === '') {
    return;
  }
  const raw = String(socketPath);
  if (socketAllow.has(raw)) {
    return;
  }
  try {
    if (socketAllow.has(path.resolve(raw))) {
      return;
    }
  } catch {
    // fall through
  }
  throw denied(`Guest agent jail: socket "${raw}" is not allowlisted.`);
};

const normalizeSpawnArgs = (file, args, options) => {
  if (args && !Array.isArray(args) && typeof args === 'object') {
    return { file, args: [], options: args };
  }
  return {
    file,
    args: Array.isArray(args) ? args : [],
    options: options && typeof options === 'object' ? options : {},
  };
};

if (jailOn) {
  const original = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    fork: childProcess.fork,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };

  childProcess.spawn = function jailSpawn(file, args, options) {
    const normalized = normalizeSpawnArgs(file, args, options);
    assertExecAllowed(normalized.file, normalized.options);
    return original.spawn.call(this, normalized.file, normalized.args, normalized.options);
  };

  childProcess.spawnSync = function jailSpawnSync(file, args, options) {
    const normalized = normalizeSpawnArgs(file, args, options);
    assertExecAllowed(normalized.file, normalized.options);
    return original.spawnSync.call(this, normalized.file, normalized.args, normalized.options);
  };

  childProcess.execFile = function jailExecFile(file, args, options, callback) {
    let nextArgs = args;
    let nextOptions = options;
    let nextCallback = callback;
    if (typeof nextArgs === 'function') {
      nextCallback = nextArgs;
      nextArgs = [];
      nextOptions = {};
    } else if (nextArgs && !Array.isArray(nextArgs) && typeof nextArgs === 'object') {
      nextCallback = nextOptions;
      nextOptions = nextArgs;
      nextArgs = [];
    } else if (typeof nextOptions === 'function') {
      nextCallback = nextOptions;
      nextOptions = {};
    }
    try {
      assertExecAllowed(file, nextOptions || {});
    } catch (error) {
      if (typeof nextCallback === 'function') {
        process.nextTick(() => nextCallback(error));
        return /** @type {any} */ ({});
      }
      throw error;
    }
    return original.execFile.call(this, file, nextArgs, nextOptions, nextCallback);
  };

  childProcess.execFileSync = function jailExecFileSync(file, args, options) {
    const normalized = normalizeSpawnArgs(file, args, options);
    assertExecAllowed(normalized.file, normalized.options);
    return original.execFileSync.call(this, normalized.file, normalized.args, normalized.options);
  };

  childProcess.exec = function jailExec(command, options, callback) {
    void command;
    void options;
    void callback;
    throw denied('Guest agent jail: child_process.exec is not allowed. Use execFile with an allowlisted binary.');
  };

  childProcess.execSync = function jailExecSync(command, options) {
    void command;
    void options;
    throw denied('Guest agent jail: child_process.execSync is not allowed. Use execFile with an allowlisted binary.');
  };

  childProcess.fork = function jailFork(modulePath, args, options) {
    void modulePath;
    void args;
    void options;
    throw denied('Guest agent jail: child_process.fork is not allowed.');
  };

  const connectWithOptions = (fn, args) => {
    const first = args[0];
    if (typeof first === 'object' && first !== null) {
      assertSocketAllowed(first.path ?? first.socketPath);
    }
    return fn.apply(net, args);
  };

  net.connect = function jailNetConnect(...args) {
    return connectWithOptions(original.netConnect, args);
  };
  net.createConnection = function jailNetCreateConnection(...args) {
    return connectWithOptions(original.netCreateConnection, args);
  };

  const wrapHttpRequest = (fn) => function jailHttpRequest(input, options, callback) {
    let opts = options;
    if (typeof input === 'string' || input instanceof URL) {
      // URL form cannot carry a unix socketPath.
    } else if (input && typeof input === 'object') {
      assertSocketAllowed(input.socketPath ?? input.path);
      opts = options;
    }
    if (opts && typeof opts === 'object' && typeof opts !== 'function') {
      assertSocketAllowed(opts.socketPath ?? opts.path);
    }
    return fn.call(this, input, options, callback);
  };

  http.request = wrapHttpRequest(original.httpRequest);
  http.get = wrapHttpRequest(original.httpGet);
  https.request = wrapHttpRequest(original.httpsRequest);
  https.get = wrapHttpRequest(original.httpsGet);
}

module.exports = {
  jailOn,
  execAllow,
  socketAllow,
  assertExecAllowed,
  assertSocketAllowed,
  commandBase,
};
