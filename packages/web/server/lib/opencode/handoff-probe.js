// The successor's half of handoff protocol 2 (self-handoff.js): a successor started with
// --handoff-probe runs this gate before it listens on the inherited fd 3, because a successor
// that is already listening is already serving real requests, so the proof it can take over
// has to happen first. Every check is read-only; nothing here claims, writes or signals.
//
//   1. fd 3 is a listening TCP socket on the port and host this process was told to serve.
//   2. The on-disk managed-OpenCode state files carry a version this build can read.
//   3. A dry run of the managed-OpenCode launch decision keeps the running child (adopt, or
//      a handoff the drain protects), and the running child's version is the predecessor's
//      to judge from the hello.
// The gate then sends the hello and waits for the predecessor's go or abort. A failed check
// is reported to the predecessor as an abort with reason `preflight-failed` before this
// process exits, so the predecessor can name the outcome instead of reporting a bare exit.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { MANAGED_OPENCODE_STATE_VERSION, resolveManagedOpenCodePaths } from './managed-opencode-state.js';
import {
  HANDOFF_ABORT_MESSAGE,
  HANDOFF_GO_MESSAGE,
  HANDOFF_HELLO_MESSAGE,
  HANDOFF_PROTOCOL_VERSION,
  INHERITED_LISTEN_FD,
} from './self-handoff.js';

export class HandoffProbeAbort extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'HandoffProbeAbort';
    this.handoffOutcome = reason;
    this.detail = detail;
  }
}

const INSPECT_FD_SCRIPT = `
const net = require('node:net');
const fd = Number(process.argv[1]);
const server = net.createServer();
server.once('error', (error) => { process.stderr.write(String((error && error.message) || error)); process.exit(1); });
server.listen({ fd }, () => {
  process.stdout.write(JSON.stringify(server.address()));
  server.close(() => process.exit(0));
});
`;

// getsockname for fd 3, run in a throwaway child: wrapping the fd in this process and closing
// the wrapper afterwards could close the descriptor itself, and this process still needs fd 3
// for its own listen once the predecessor says go. The child gets its own copy of the fd as
// its fd 3 (the stdio slot), reports the address, and exits; the socket itself stays open
// because the predecessor holds its descriptor throughout.
const inspectInheritedFd = (fd, run = spawnSync) => {
  const result = run(process.execPath, ['-e', INSPECT_FD_SCRIPT, String(fd)], {
    stdio: ['ignore', 'pipe', 'pipe', fd],
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) {
    return { ok: false, detail: `the inherited listener fd ${fd} could not be inspected (${String(result.stderr ?? 'no output').trim() || 'inspection failed'})` };
  }
  try {
    const address = JSON.parse(result.stdout);
    if (!Number.isInteger(address?.port)) {
      return { ok: false, detail: `the inherited fd ${fd} is not a listening TCP socket` };
    }
    return { ok: true, address };
  } catch {
    return { ok: false, detail: `the inherited fd ${fd} is not a listening TCP socket` };
  }
};

const normalizeHost = (host) => String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();

export const checkInheritedListenerAddress = ({ fd = INHERITED_LISTEN_FD, port, host, inspect = inspectInheritedFd } = {}) => {
  const inspected = inspect(fd);
  if (!inspected.ok) return inspected;
  const { address } = inspected;
  if (address.port !== port) {
    return { ok: false, detail: `the inherited listener is on port ${address.port}, not the port ${port} this successor was started for` };
  }
  if (normalizeHost(address.address) !== normalizeHost(host)) {
    return { ok: false, detail: `the inherited listener is bound to ${address.address}, not the host ${host} this successor was started for` };
  }
  return { ok: true, address };
};

// The state files the predecessor wrote, judged by version only: a file that is missing is a
// fresh state the successor can start from; a file that is present but unreadable, malformed
// or at another version is one the successor cannot read, which is a preflight failure.
export const checkStateVersions = ({ dataDir, readFile = readBoundedFileSync } = {}) => {
  const { statePath, drainingPath } = resolveManagedOpenCodePaths(dataDir);
  for (const filePath of [statePath, drainingPath]) {
    const result = readFile(filePath, 64 * 1024);
    if (!result.ok) {
      try {
        fs.lstatSync(filePath);
      } catch {
        continue;
      }
      return { ok: false, detail: `${path.basename(filePath)} exists but could not be read` };
    }
    let parsed;
    try {
      parsed = JSON.parse(result.buffer.toString('utf8'));
    } catch {
      return { ok: false, detail: `${path.basename(filePath)} is not valid JSON` };
    }
    if (parsed?.version !== MANAGED_OPENCODE_STATE_VERSION) {
      return { ok: false, detail: `${path.basename(filePath)} is version ${String(parsed?.version)}, and this build reads version ${MANAGED_OPENCODE_STATE_VERSION}` };
    }
  }
  return { ok: true, stateVersion: MANAGED_OPENCODE_STATE_VERSION };
};

// Runs the preflight, sends the hello, and resolves on `go`. Any failure throws
// HandoffProbeAbort with the named outcome; the caller (serve) exits on it without having
// listened, written pid files or touched the managed OpenCode.
export const createHandoffProbeGate = ({
  version,
  dataDir,
  previewOpenCode,
  send = (message) => process.send?.(message),
  onMessage = (handler) => {
    process.on('message', handler);
    return () => process.off('message', handler);
  },
  checkListener = checkInheritedListenerAddress,
  checkState = checkStateVersions,
  log = console,
}) => async ({ port, bindHost }) => {
  const fail = (detail) => {
    try {
      send({ type: HANDOFF_ABORT_MESSAGE, reason: 'preflight-failed', detail });
    } catch {
      // The predecessor is gone; exiting with the outcome is the remaining signal.
    }
    throw new HandoffProbeAbort('preflight-failed', detail);
  };

  const listener = await checkListener({ port, host: bindHost });
  if (!listener.ok) fail(listener.detail);
  const state = checkState({ dataDir });
  if (!state.ok) fail(state.detail);
  let preview;
  try {
    preview = await previewOpenCode({ listenerPort: port });
  } catch (error) {
    fail(`the managed OpenCode launch could not be previewed: ${error?.message ?? error}`);
  }

  const hello = {
    type: HANDOFF_HELLO_MESSAGE,
    version,
    handoffProtocol: HANDOFF_PROTOCOL_VERSION,
    stateVersion: state.stateVersion,
    opencode: {
      decision: preview?.decision?.action ?? 'start',
      reason: preview?.decision?.reason ?? 'unknown',
      version: preview?.openCodeVersion ?? null,
    },
  };
  if (hello.opencode.decision === 'handoff') {
    log.log(`[handoff] the takeover starts a new OpenCode generation (${hello.opencode.reason}); the drain protects its sessions`);
  }

  const verdict = await new Promise((resolve) => {
    const off = onMessage((message) => {
      if (message?.type === HANDOFF_GO_MESSAGE) {
        off();
        resolve({ go: true });
      } else if (message?.type === HANDOFF_ABORT_MESSAGE) {
        off();
        resolve({ go: false, reason: message.reason === 'preflight-failed' ? 'preflight-failed' : 'incompatible', detail: message.detail == null ? undefined : String(message.detail) });
      }
    });
    try {
      send(hello);
    } catch (error) {
      off();
      resolve({ go: false, reason: 'preflight-failed', detail: `the hello could not be sent: ${error?.message ?? error}` });
    }
  });
  if (!verdict.go) throw new HandoffProbeAbort(verdict.reason, verdict.detail);
  log.log('[handoff] the predecessor approved this takeover; listening on the inherited socket');
};
