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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedFileSync, type BoundedFileRead } from '../shared/bounded-file-read.js';
import { MANAGED_OPENCODE_STATE_VERSION, resolveManagedOpenCodePaths } from './managed-opencode-state.js';
import {
  HANDOFF_ABORT_MESSAGE,
  HANDOFF_GO_MESSAGE,
  HANDOFF_HELLO_MESSAGE,
  HANDOFF_PROTOCOL_VERSION,
  INHERITED_LISTEN_FD,
} from './self-handoff.js';

type AbortReason = 'preflight-failed' | 'incompatible';

export class HandoffProbeAbort extends Error {
  readonly handoffOutcome: AbortReason;
  readonly detail: string | undefined;

  constructor(reason: AbortReason, detail?: string) {
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

const listenerAddressSchema = z.object({ port: z.number().int(), address: z.string() }).loose();
type ListenerAddress = z.infer<typeof listenerAddressSchema>;
type ListenerCheck = { ok: true; address: ListenerAddress } | { ok: false; detail: string };
type InspectRun = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'pipe', number]; encoding: 'utf8'; timeout: number }) => SpawnSyncReturns<string>;

// getsockname for fd 3, run in a throwaway child: wrapping the fd in this process and closing
// the wrapper afterwards could close the descriptor itself, and this process still needs fd 3
// for its own listen once the predecessor says go. The child gets its own copy of the fd as
// its fd 3 (the stdio slot), reports the address, and exits; the socket itself stays open
// because the predecessor holds its descriptor throughout.
const inspectInheritedFd = (fd: number, run: InspectRun = spawnSync): ListenerCheck => {
  const result = run(process.execPath, ['-e', INSPECT_FD_SCRIPT, String(fd)], {
    stdio: ['ignore', 'pipe', 'pipe', fd],
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0 || !result.stdout) {
    return { ok: false, detail: `the inherited listener fd ${fd} could not be inspected (${String(result.stderr ?? 'no output').trim() || 'inspection failed'})` };
  }
  try {
    const address = listenerAddressSchema.safeParse(JSON.parse(result.stdout));
    return address.success ? { ok: true, address: address.data } : { ok: false, detail: `the inherited fd ${fd} is not a listening TCP socket` };
  } catch {
    return { ok: false, detail: `the inherited fd ${fd} is not a listening TCP socket` };
  }
};

const normalizeHost = (host: string) => host.replace(/^\[|\]$/g, '').toLowerCase();

export const checkInheritedListenerAddress = ({ fd = INHERITED_LISTEN_FD, port, host, inspect = inspectInheritedFd }: {
  fd?: number;
  port: number;
  host: string;
  inspect?: (fd: number) => ListenerCheck;
}): ListenerCheck => {
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

const stateVersionSchema = z.object({ version: z.json().optional() }).loose();
type StateCheck = { ok: true; stateVersion: number } | { ok: false; detail: string };

// The state files the predecessor wrote, judged by version only: a file that is missing is a
// fresh state the successor can start from; a file that is present but unreadable, malformed
// or at another version is one the successor cannot read, which is a preflight failure.
export const checkStateVersions = ({ dataDir, readFile = readBoundedFileSync }: {
  dataDir: string;
  readFile?: (filePath: string, maxBytes: number) => BoundedFileRead;
}): StateCheck => {
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
      parsed = stateVersionSchema.safeParse(JSON.parse(result.buffer.toString('utf8')));
    } catch {
      return { ok: false, detail: `${path.basename(filePath)} is not valid JSON` };
    }
    const version = parsed.success ? parsed.data.version : undefined;
    if (version !== MANAGED_OPENCODE_STATE_VERSION) {
      return { ok: false, detail: `${path.basename(filePath)} is version ${String(version)}, and this build reads version ${MANAGED_OPENCODE_STATE_VERSION}` };
    }
  }
  return { ok: true, stateVersion: MANAGED_OPENCODE_STATE_VERSION };
};

type OpenCodePreview = {
  decision?: { action?: string | null; reason?: string | null } | null;
  openCodeVersion?: string | null;
} | null | undefined;

const verdictMessageSchema = z.object({ type: z.string(), reason: z.json().optional(), detail: z.json().optional() }).loose();
type Verdict = { go: true } | { go: false; reason: AbortReason; detail: string | undefined };
type HandoffMessage = Record<string, string | number | null | Record<string, string | null>>;
type ProcessMessage = Parameters<NodeJS.MessageListener>[0];
type Unsubscribe = () => void;
type ProbeLog = Pick<Console, 'log'>;

// Runs the preflight, sends the hello, and resolves on `go`. Any failure throws
// HandoffProbeAbort with the named outcome; the caller (serve) exits on it without having
// listened, written pid files or touched the managed OpenCode.
export const createHandoffProbeGate = ({
  version,
  dataDir,
  previewOpenCode,
  send = (message) => { process.send?.(message); },
  onMessage = (handler) => {
    process.on('message', handler);
    return () => process.off('message', handler);
  },
  onDisconnect = (handler) => {
    process.on('disconnect', handler);
    return () => process.off('disconnect', handler);
  },
  checkListener = checkInheritedListenerAddress,
  checkState = checkStateVersions,
  log = console,
}: {
  version: string;
  dataDir: string;
  previewOpenCode: (input: { listenerPort: number }) => Promise<OpenCodePreview>;
  send?: (message: HandoffMessage) => void;
  onMessage?: (handler: (message: ProcessMessage) => void) => Unsubscribe;
  onDisconnect?: (handler: () => void) => Unsubscribe;
  checkListener?: (input: { port: number; host: string }) => ListenerCheck | Promise<ListenerCheck>;
  checkState?: (input: { dataDir: string }) => StateCheck;
  log?: ProbeLog;
}) => async ({ port, bindHost }: { port: number; bindHost: string }) => {
  const fail = (detail: string): never => {
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
  if (!state.ok) return fail(state.detail);
  let preview: OpenCodePreview;
  try {
    preview = await previewOpenCode({ listenerPort: port });
  } catch (error) {
    fail(`the managed OpenCode launch could not be previewed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const opencode = {
    decision: preview?.decision?.action ?? 'start',
    reason: preview?.decision?.reason ?? 'unknown',
    version: preview?.openCodeVersion ?? null,
  };
  const hello = {
    type: HANDOFF_HELLO_MESSAGE,
    version,
    handoffProtocol: HANDOFF_PROTOCOL_VERSION,
    stateVersion: state.stateVersion,
    opencode,
  } satisfies HandoffMessage;
  if (opencode.decision === 'handoff') {
    log.log(`[handoff] the takeover starts a new OpenCode generation (${opencode.reason}); the drain protects its sessions`);
  }

  const verdict = await new Promise<Verdict>((resolve) => {
    let offMessage: Unsubscribe = () => {};
    let offDisconnect: Unsubscribe = () => {};
    const settle = (result: Verdict) => {
      offMessage();
      offDisconnect();
      resolve(result);
    };
    offMessage = onMessage((message) => {
      const parsed = verdictMessageSchema.safeParse(message);
      if (!parsed.success) return;
      if (parsed.data.type === HANDOFF_GO_MESSAGE) {
        settle({ go: true });
      } else if (parsed.data.type === HANDOFF_ABORT_MESSAGE) {
        const { reason, detail } = parsed.data;
        settle({ go: false, reason: reason === 'preflight-failed' ? 'preflight-failed' : 'incompatible', detail: detail == null ? undefined : String(detail) });
      }
    });
    // The budget for the exchange lives on the predecessor's side; a successor whose
    // predecessor dies mid-exchange has nobody left to answer, and waiting would hold
    // its copy of the listener open with the port wedged. The closed channel is its
    // signal to give up the same way a refusal does.
    offDisconnect = onDisconnect(() => {
      settle({ go: false, reason: 'preflight-failed', detail: 'the predecessor closed the handoff channel before answering the hello' });
    });
    try {
      send(hello);
    } catch (error) {
      settle({ go: false, reason: 'preflight-failed', detail: `the hello could not be sent: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
  if (!verdict.go) throw new HandoffProbeAbort(verdict.reason, verdict.detail);
  log.log('[handoff] the predecessor approved this takeover; listening on the inherited socket');
};
