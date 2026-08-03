import fs from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { removeFileByIdentity } from './discovery-file.js';
import {
  sameFileIdentity,
  sameFileObjectIdentity,
  snapshotFileIdentity,
} from './file-identity.js';

const DEFAULT_SOCKET_MODE = 0o600;
const DEFAULT_UMASK = 0o077;
const PUBLICATION_PROBE_TIMEOUT_MS = 1_000;
const PUBLICATION_HANDLE_MARKER = 'guardian-ipc-publication-handle';
const PUBLICATION_HANDLE_ACCEPT = 'guardian-ipc-publication-accept';
const PUBLICATION_HANDLE_COMMIT = 'guardian-ipc-publication-commit';
const PUBLICATION_HANDLE_COMMIT_ACK = 'guardian-ipc-publication-commit-ack';
const PUBLICATION_HANDLE_COMMIT_CONFIRM = 'guardian-ipc-publication-commit-confirm';
// Linux exposes O_PATH for opening a Unix-socket pathname without attempting
// to connect to it. Its fstat identity is the filesystem inode (unlike the
// listener socket FD's sockfs identity), and the descriptor can be held across
// public hard-link publication to fence unlink/recreate races. The descriptor
// remains held through the helper lifecycle so shutdown cannot adopt a replaced
// pathname pair.
const LINUX_O_PATH = 0x200000;
const LINUX_PROC_FD_PATH = '/proc/self/fd';

const ownerPathFor = (socketPath) => `${socketPath}.owner`;

let listener = null;
let started = false;
let exiting = false;
let readyPublished = false;
let shutdownRequested = false;
let boundIdentity = null;
let activeSocketPath = null;
let activeOwnerPath = null;
let activePublicationPlatform = process.platform;
let publicationProven = false;
let publicationProbe = null;
let publicationInProgress = false;
let heldBoundPathDescriptor = null;
let publicationToken = null;
let publicationCandidateProof = null;
let publicationTokenClient = null;
let publicationTokenSocket = null;
let publicationTokenData = '';
let publicationTokenAcceptanceInProgress = false;
let publicationCommitSent = false;
let publicationCommitAcknowledged = false;
let publicationCommitConfirmationInProgress = false;
let readyFramePublished = false;
let readyAcceptanceInProgress = false;

const helperPathEnv = () => ({ PATH: process.env.PATH || '/usr/bin:/bin' });

const closeHeldBoundPathDescriptor = () => {
  const descriptor = heldBoundPathDescriptor;
  heldBoundPathDescriptor = null;
  if (descriptor === null) return;
  try { fs.closeSync(descriptor); } catch { /* The process is already exiting. */ }
};

const unsupportedPublicationError = (message = 'POSIX listener publication is unavailable') =>
  Object.assign(new Error(message), { code: 'ENOTSUP' });

const assertPublicationIdentitySupported = (identity, artifactPath) => {
  if (activePublicationPlatform !== 'linux' && identity?.birthtime === null) {
    throw unsupportedPublicationError(
      `POSIX ctime-only guardian socket publication requires Linux descriptor fencing: ${artifactPath}`,
    );
  }
  return identity;
};

const POSIX_PUBLICATION_PLATFORMS = new Set([
  'linux',
  'darwin',
  'freebsd',
  'openbsd',
  'netbsd',
  'sunos',
  'aix',
]);

const hasPublicationSupport = (platform) => (
  POSIX_PUBLICATION_PLATFORMS.has(platform)
  && (platform !== 'linux' || fs.existsSync(LINUX_PROC_FD_PATH))
);

const publicationLine = (kind, token) => `${kind}:${token}\n`;

const closePublicationToken = () => {
  const socket = publicationTokenSocket;
  publicationTokenSocket = null;
  try { socket?.destroy?.(); } catch { /* The helper is already shutting down. */ }

  const client = publicationTokenClient;
  publicationTokenClient = null;
  publicationTokenData = '';
  publicationCommitSent = false;
  publicationCommitAcknowledged = false;
  try { client?.destroy?.(); } catch { /* The helper is already shutting down. */ }
};

const abortPublicationProbe = (error = new Error('Guardian IPC publication probe aborted')) => {
  const probe = publicationProbe;
  if (!probe) return;
  publicationProbe = null;
  clearTimeout(probe.timer);
  try { probe.client?.destroy?.(); } catch { /* The helper is already shutting down. */ }
  for (const socket of probe.sockets) {
    try { socket.destroy?.(); } catch { /* The helper is already shutting down. */ }
  }
  probe.sockets.clear();
  probe.reject(error);
};

const acceptPublicationProbeSocket = (socket) => {
  const probe = publicationProbe;
  if (!probe) {
    try { socket.destroy(); } catch { /* The helper is already shutting down. */ }
    return;
  }

  probe.sockets.add(socket);
  let received = '';
  const onProbeData = (chunk) => {
    const currentProbe = publicationProbe;
    if (currentProbe !== probe) {
      try { socket.destroy(); } catch { /* The helper is already shutting down. */ }
      return;
    }
    received += chunk.toString();
    if (!received.includes(`${probe.nonce}\n`)) return;

    publicationProbe = null;
    clearTimeout(probe.timer);
    probe.sockets.delete(socket);
    for (const probeSocket of probe.sockets) {
      try { probeSocket.destroy?.(); } catch { /* The helper is already shutting down. */ }
    }
    probe.sockets.clear();
    socket.removeListener('data', onProbeData);
    socket.pause?.();

    if (!probe.retain) {
      try { socket.destroy?.(); } catch { /* The helper is already shutting down. */ }
      try { probe.client?.destroy?.(); } catch { /* The helper is already shutting down. */ }
      probe.resolve(null);
      return;
    }

    probe.resolve({ client: probe.client, socket });
  };
  socket.on('data', onProbeData);
  socket.on('error', () => {
    // The timeout owns probe failure. A replacement endpoint may accept and
    // close a connection without ever proving that this listener accepted it.
  });
};

const runPublicationProbe = (socketPath, { retain = false } = {}) => new Promise((resolve, reject) => {
  const nonce = randomBytes(16).toString('hex');
  const probe = {
    nonce,
    retain,
    resolve,
    reject,
    client: null,
    sockets: new Set(),
    timer: null,
  };
  publicationProbe = probe;
  probe.timer = setTimeout(() => {
    if (publicationProbe !== probe) return;
    abortPublicationProbe(new Error('Guardian IPC publication did not reach the bound listener'));
  }, PUBLICATION_PROBE_TIMEOUT_MS);
  probe.timer.unref?.();

  const client = net.createConnection(socketPath);
  probe.client = client;
  client.once('connect', () => {
    try { client.write(`${nonce}\n`); } catch (error) {
      abortPublicationProbe(error);
    }
  });
  client.once('error', (error) => {
    if (publicationProbe === probe) abortPublicationProbe(error);
  });
  client.once('close', () => {
    if (publicationProbe === probe) {
      abortPublicationProbe(new Error('Guardian IPC publication probe connection closed'));
    }
  });
});

const readPublishedIdentitySet = () => {
  const bound = readBoundListenerIdentity(
    activeOwnerPath,
    heldBoundPathDescriptor,
    activePublicationPlatform,
  );
  const publicStat = fs.lstatSync(activeSocketPath);
  const ownerStat = fs.lstatSync(activeOwnerPath);
  const publicIdentity = snapshotFileIdentity(publicStat);
  const ownerIdentity = snapshotFileIdentity(ownerStat);
  if (
    listener.address() !== activeOwnerPath
    || !publicStat.isSocket?.()
    || !ownerStat.isSocket?.()
    || !publicIdentity
    || !ownerIdentity
    || !sameFileIdentity(bound.identity, publicIdentity)
    || !sameFileIdentity(bound.identity, ownerIdentity)
    || !sameFileIdentity(publicIdentity, ownerIdentity)
  ) {
    throw new Error('Guardian IPC publication identity is unavailable or mismatched');
  }

  for (const identity of [bound.identity, publicIdentity, ownerIdentity]) {
    assertPublicationIdentitySupported(identity, activeSocketPath);
  }

  return {
    listenerIdentity: bound.listenerIdentity,
    boundPathIdentity: bound.identity,
    descriptorIdentity: bound.identity,
    publicIdentity,
    ownerIdentity,
  };
};

const provePublishedEndpoint = async ({ retain = false } = {}) => {
  // Capture the exact published pair before the probe. Linux roots that pair in
  // the held descriptor; other POSIX platforms root it in the checked owner
  // pathname. The probe itself is accepted only by this helper's listener, not
  // by whatever endpoint may have replaced the public pathname.
  readPublishedIdentitySet();
  const probe = await runPublicationProbe(activeSocketPath, { retain });

  // The final proof is rooted in the held Linux descriptor (or the checked
  // non-Linux owner pathname) and the helper-owned listener FD. Pathname stats
  // corroborate that proof; they do not become the readiness decision.
  try {
    const proof = readPublishedIdentitySet();
    return retain ? { proof, ...probe } : proof;
  } catch (error) {
    if (retain) {
      try { probe?.socket?.destroy?.(); } catch { /* The helper is already shutting down. */ }
      try { probe?.client?.destroy?.(); } catch { /* The helper is already shutting down. */ }
    }
    throw error;
  }
};

const samePublicationObject = (left, right) => (
  sameFileObjectIdentity(left?.listenerIdentity, right?.listenerIdentity)
  && sameFileObjectIdentity(left?.boundPathIdentity, right?.boundPathIdentity)
  && sameFileObjectIdentity(left?.descriptorIdentity, right?.descriptorIdentity)
  && sameFileObjectIdentity(left?.publicIdentity, right?.publicIdentity)
  && sameFileObjectIdentity(left?.ownerIdentity, right?.ownerIdentity)
);

const publicationMessage = (type, proof) => ({
  type,
  publicationToken,
  publicationHandle: 'accepted-probe',
  publicationProof: {
    token: publicationToken,
    ...proof,
  },
  // Keep the identity fields visible in the boundary frame for diagnostics and
  // for older boundary fixtures, while the parent authorizes readiness only
  // from publicationProof.
  identity: proof.publicIdentity,
  handleIdentity: proof,
  publicIdentity: proof.publicIdentity,
  ownerIdentity: proof.ownerIdentity,
});

/**
 * Hard-link the exact inode held by an O_PATH descriptor. Node's portable
 * fs.linkSync() only accepts pathnames and therefore reopens the source name;
 * on Linux, coreutils `ln -L` passes AT_SYMLINK_FOLLOW to linkat(), allowing
 * the inherited `/proc/self/fd/<n>` magic link to remain descriptor-backed.
 * The destination is no-clobber (`-T` without `-f`).
 */
const linkFromHeldDescriptor = (descriptor, destination) => {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw unsupportedPublicationError('Guardian IPC publication descriptor is unavailable');
  }

  const result = spawnSync('ln', [
    '-L',
    '-T',
    '--',
    `${LINUX_PROC_FD_PATH}/3`,
    destination,
  ], {
    env: helperPathEnv(),
    stdio: ['ignore', 'ignore', 'ignore', descriptor],
  });
  if (result.error) {
    throw Object.assign(
      unsupportedPublicationError('Guardian IPC FD-backed publication command is unavailable'),
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const error = new Error('Guardian IPC FD-backed publication failed');
    error.code = fs.existsSync(destination) ? 'EEXIST' : 'EIO';
    throw error;
  }
};

/**
 * Non-Linux POSIX does not expose Linux's O_PATH + /proc/fd publication
 * primitive. Keep the source pathname and the destination no-clobber, then
 * require the actual-listener probe below before readiness. A source-path
 * replacement cannot satisfy that probe because only this helper's listener
 * accepts the nonce.
 */
const linkFromBoundPath = (source, destination, expectedIdentity) => {
  const sourceStat = fs.lstatSync(source);
  if (
    sourceStat.isSymbolicLink?.()
    || !sourceStat.isSocket?.()
    || !sameFileIdentity(expectedIdentity, sourceStat)
  ) {
    throw new Error('Guardian IPC pathname publication source identity is unavailable or mismatched');
  }

  try {
    fs.linkSync(source, destination);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const destinationStat = fs.lstatSync(destination);
      const destinationIdentity = snapshotFileIdentity(destinationStat);
      if (
        destinationStat.isSocket?.()
        && destinationIdentity
        && sameFileIdentity(expectedIdentity, destinationIdentity)
      ) {
        return;
      }
      error.code = 'EEXIST';
    }
    throw error;
  }

  const publishedStat = fs.lstatSync(destination);
  const publishedIdentity = snapshotFileIdentity(publishedStat);
  if (
    publishedStat.isSymbolicLink?.()
    || !publishedStat.isSocket?.()
    || !publishedIdentity
    || !sameFileIdentity(expectedIdentity, publishedIdentity)
  ) {
    throw new Error('Guardian IPC pathname publication identity is unavailable or mismatched');
  }
};

const sendMessage = (message, handle, callback) => {
  if (!process.connected || typeof process.send !== 'function') {
    try { handle?.destroy?.(); } catch { /* The parent is already gone. */ }
    return false;
  }

  try {
    if (handle === undefined) process.send(message, callback);
    else process.send(message, handle, callback);
    return true;
  } catch {
    try { handle?.destroy?.(); } catch { /* The parent is already gone. */ }
    return false;
  }
};

const cleanupUnannouncedArtifacts = () => {
  if (readyPublished || !publicationProven || !boundIdentity) return;
  if (activePublicationPlatform !== 'linux' && boundIdentity.birthtime === null) return;

  const refreshHeldBoundIdentity = () => {
    if (heldBoundPathDescriptor === null) return boundIdentity;
    const heldStat = fs.fstatSync(heldBoundPathDescriptor);
    const heldIdentity = snapshotFileIdentity(heldStat);
    if (!heldIdentity || !heldStat.isSocket?.() || !sameFileObjectIdentity(boundIdentity, heldIdentity)) {
      throw unsupportedPublicationError('Guardian IPC bound socket identity changed during cleanup');
    }
    boundIdentity = heldIdentity;
    return heldIdentity;
  };

  // A helper that never completed the ready publication owns only the
  // bound owner inode it just bound. Remove each pathname independently
  // through the shared identity-fenced quarantine primitive so a replacement
  // at either pathname is preserved. This is deliberately best-effort: an
  // uncertain replacement remains visible for the parent/stale recovery path
  // rather than being removed by name.
  const artifacts = [
    [activeOwnerPath, 'unannounced guardian owner alias'],
    [activeSocketPath, 'unannounced guardian socket'],
  ];
  const observations = new Map();
  const cleanupArtifacts = new Map();
  const cleanupIssues = [];
  for (const [artifactPath, label] of artifacts) {
    if (typeof artifactPath !== 'string') continue;

    let stat;
    try {
      stat = fs.lstatSync(artifactPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      return;
    }
    if (
      stat.isSymbolicLink?.()
      || !stat.isSocket?.()
      || !sameFileIdentity(boundIdentity, stat)
    ) return;
    observations.set(artifactPath, stat);
    cleanupArtifacts.set(artifactPath, {
      path: artifactPath,
      label,
      identity: { ...boundIdentity },
      quarantinePath: null,
    });
  }

  for (const [artifactPath, label] of artifacts) {
    if (typeof artifactPath !== 'string' || !observations.has(artifactPath)) continue;

    const tracked = cleanupArtifacts.get(artifactPath);
    try {
      const expectedIdentity = refreshHeldBoundIdentity();
      tracked.identity = { ...expectedIdentity };
      const result = removeFileByIdentity(artifactPath, expectedIdentity, {
        label,
        expectedType: 'socket',
        platform: activePublicationPlatform,
        returnResult: true,
        onQuarantinePath: (quarantinePath) => {
          tracked.quarantinePath = quarantinePath;
        },
        onIdentity: (identity) => {
          tracked.identity = { ...identity };
          boundIdentity = { ...identity };
        },
      });
      if (result?.status !== 'removed' && result?.status !== 'absent') {
        cleanupIssues.push({
          ...tracked,
          status: result?.status || 'cleanup-uncertain',
          errorCode: result?.error?.code,
        });
      }
      refreshHeldBoundIdentity();
    } catch (error) {
      // Preserve the artifact when identity-safe cleanup is uncertain. The
      // helper has no authority to remove an object it can no longer prove is
      // the bound listener.
      cleanupIssues.push({
        ...tracked,
        status: 'cleanup-uncertain',
        errorCode: error?.code,
      });
    }
  }

  if (cleanupIssues.length === 0) return null;
  return {
    code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    phase: 'unannounced-cleanup',
    artifacts: cleanupIssues,
  };
};

/**
 * Close this helper by exiting the process, deliberately without calling
 * `listener.close()`. Node/libuv remembers the Unix socket pathname on the
 * listener and may unlink that pathname during a high-level close. The
 * guardian parent owns identity-checked cleanup; process exit only releases
 * this helper's listener descriptor.
 */
const exitWithoutPathCleanup = (code = 0) => {
  if (exiting) return;
  exiting = true;
  abortPublicationProbe(new Error('Guardian IPC helper is exiting'));
  closePublicationToken();
  const cleanup = !readyPublished ? cleanupUnannouncedArtifacts() : null;
  if (cleanup) {
    closeHeldBoundPathDescriptor();
    const sent = sendMessage({
      type: 'error',
      code: cleanup.code,
      phase: cleanup.phase,
      cleanupArtifacts: cleanup.artifacts,
    }, undefined, () => process.exit(code));
    if (!sent) process.exit(code);
    return;
  }
  closeHeldBoundPathDescriptor();
  process.exit(code);
};

const scheduleUnannouncedExit = (code = 0) => {
  if (readyPublished || exiting) return;
  if (
    !listener
    || publicationProven
    || (!publicationInProgress && (listener.listening || boundIdentity))
  ) {
    exitWithoutPathCleanup(code);
  }
  // A bind is still pending. Let its listen callback perform the
  // descriptor-backed cleanup; exiting here could close the FD after the
  // pathname is created but before the helper has recorded its identity.
};

const reportError = (code, phase) => {
  // Before publication is proven, any path identity may belong to a
  // replacement that won the bind-to-capture race. Do not let helper exit
  // cleanup unlink it by treating the pathname snapshot as ownership.
  if (!publicationProven) boundIdentity = null;
  abortPublicationProbe(new Error(`Guardian IPC publication failed (${phase || 'unknown'})`));
  closePublicationToken();
  if (!sendMessage({ type: 'error', code, phase })) {
    exitWithoutPathCleanup(1);
    return;
  }
  // Do not close the listener through Node. The parent will identity-check the
  // path after this process exits, even for startup failures after bind.
  setImmediate(() => exitWithoutPathCleanup(1));
};

const finishReadyShutdown = () => {
  if (exiting) return;

  let descriptorIdentity;
  let publicIdentity;
  let ownerIdentity;
  try {
    // Do not call server.close(): libuv may unlink the bound owner pathname.
    // The parent remains the cleanup authority. Linux uses the held O_PATH
    // descriptor for this final metadata refresh. Other POSIX platforms use
    // the owner pathname plus the same listener/probe fence used at startup.
    const descriptorStat = heldBoundPathDescriptor === null
      ? fs.lstatSync(activeOwnerPath)
      : fs.fstatSync(heldBoundPathDescriptor);
    descriptorIdentity = snapshotFileIdentity(descriptorStat);
    const publicStat = fs.lstatSync(activeSocketPath);
    const ownerStat = fs.lstatSync(activeOwnerPath);
    publicIdentity = snapshotFileIdentity(publicStat);
    ownerIdentity = snapshotFileIdentity(ownerStat);
    if (
      !descriptorStat.isSocket?.()
      || !descriptorIdentity
      || !publicStat.isSocket?.()
      || !ownerStat.isSocket?.()
      || !publicIdentity
      || !ownerIdentity
      || !sameFileIdentity(descriptorIdentity, publicIdentity)
      || !sameFileIdentity(descriptorIdentity, ownerIdentity)
      || !sameFileIdentity(publicIdentity, ownerIdentity)
    ) {
      throw new Error('Guardian IPC shutdown identity is unavailable or mismatched');
    }
    assertPublicationIdentitySupported(descriptorIdentity, activeOwnerPath);
    boundIdentity = descriptorIdentity;
  } catch {
    // The parent remains the cleanup authority and will retain the pair when
    // this final identity handoff cannot be proven.
    exitWithoutPathCleanup(0);
    return;
  }

  if (!sendMessage({
    type: 'closed',
    descriptorIdentity,
    publicIdentity,
    ownerIdentity,
  }, undefined, () => exitWithoutPathCleanup(0))) {
    exitWithoutPathCleanup(0);
  }
};

const readBoundListenerIdentity = (
  boundSocketPath,
  heldPathDescriptor,
  publicationPlatform = process.platform,
) => {
  const listenerDescriptor = listener?._handle?.fd;
  if (!Number.isSafeInteger(listenerDescriptor) || listenerDescriptor < 0) {
    throw new Error('bound listener descriptor is unavailable');
  }

  const listenerStat = fs.fstatSync(listenerDescriptor);
  if (!listenerStat.isSocket?.()) {
    throw new Error('bound listener identity is unavailable');
  }
  const listenerIdentity = snapshotFileIdentity(listenerStat);
  if (!listenerIdentity || listenerIdentity.type !== 'socket') {
    throw new Error('bound listener identity is unavailable');
  }

  let descriptor = heldPathDescriptor ?? undefined;
  let openedHere = false;
  try {
    if (descriptor === undefined && publicationPlatform === 'linux') {
      descriptor = fs.openSync(
        boundSocketPath,
        LINUX_O_PATH | (fs.constants.O_NOFOLLOW ?? 0),
      );
      openedHere = true;
    }

    const stat = descriptor === undefined
      ? fs.lstatSync(boundSocketPath)
      : fs.fstatSync(descriptor);
    const identity = snapshotFileIdentity(stat);
    if (!stat.isSocket?.() || !identity || identity.type !== 'socket') {
      throw new Error('bound listener identity is unavailable');
    }
    return { descriptor, identity, listenerIdentity };
  } catch (error) {
    if (openedHere && descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
    throw error;
  }
};

const finishReadyCommit = async () => {
  if (
    exiting
    || readyPublished
    || publicationTokenAcceptanceInProgress
    || publicationCommitSent
    || !readyFramePublished
    || !publicationProven
    || !publicationCandidateProof
    || !publicationTokenClient
  ) return;

  publicationTokenAcceptanceInProgress = true;
  try {
    // The accepted probe handle is held by the parent while it acknowledges
    // the ready frame. Re-probe only after that acknowledgement so a native
    // replacement inserted after the earlier helper proof cannot cross the
    // readiness fence.
    const proof = await provePublishedEndpoint();
    if (!samePublicationObject(publicationCandidateProof, proof)) {
      throw new Error('Guardian IPC publication changed before readiness commit');
    }
    if (publicationTokenClient === null || shutdownRequested || !process.connected) {
      exitWithoutPathCleanup(0);
      return;
    }

    const client = publicationTokenClient;
    const commit = publicationLine(PUBLICATION_HANDLE_COMMIT, publicationToken);
    publicationCommitSent = true;
    try {
      client.write(commit, (error) => {
        if (error) {
          publicationCommitSent = false;
          readyPublished = false;
          reportError(error.code || 'EPIPE', 'ready-commit');
          return;
        }
        void finishReadyCommitConfirmation();
      });
    } catch (error) {
      publicationCommitSent = false;
      reportError(error?.code || 'EPIPE', 'ready-commit');
    }
  } catch (error) {
    reportError(error?.code || 'EIO', 'ready-commit');
  } finally {
    publicationTokenAcceptanceInProgress = false;
  }
};

const finishReadyCommitConfirmation = async () => {
  if (
    exiting
    || readyPublished
    || publicationCommitConfirmationInProgress
    || !publicationCommitSent
    || !publicationCommitAcknowledged
    || !publicationCandidateProof
    || !publicationTokenClient
  ) return;

  publicationCommitConfirmationInProgress = true;
  try {
    // The parent acknowledgement is a second phase of the readiness fence.
    // Re-probe the actual listener after the parent has corroborated the
    // commit marker so a replacement cannot be accepted by the token alone.
    const proof = await provePublishedEndpoint();
    if (!samePublicationObject(publicationCandidateProof, proof)) {
      throw new Error('Guardian IPC publication changed before readiness confirmation');
    }
    if (publicationTokenClient === null || shutdownRequested || !process.connected) {
      exitWithoutPathCleanup(0);
      return;
    }

    const client = publicationTokenClient;
    const confirmation = publicationLine(PUBLICATION_HANDLE_COMMIT_CONFIRM, publicationToken);
    try {
      client.write(confirmation, (error) => {
        if (error) {
          readyPublished = false;
          reportError(error.code || 'EPIPE', 'ready-commit-confirm');
          return;
        }
        readyPublished = true;
        publicationInProgress = false;
        closePublicationToken();
      });
    } catch (error) {
      reportError(error?.code || 'EPIPE', 'ready-commit-confirm');
    }
  } catch (error) {
    reportError(error?.code || 'EIO', 'ready-commit-confirm');
  } finally {
    publicationCommitConfirmationInProgress = false;
  }
};

const installPublicationTokenClient = (client) => {
  publicationTokenClient = client;
  publicationTokenData = '';
  client.on('data', (chunk) => {
    if (publicationTokenClient !== client) return;
    publicationTokenData += chunk.toString();
    if (publicationTokenData.length > 4096) {
      reportError('EINVAL', 'publication-token');
      return;
    }
    const commitAcknowledgement = publicationLine(PUBLICATION_HANDLE_COMMIT_ACK, publicationToken);
    if (
      publicationCommitSent
      && !publicationCommitAcknowledged
      && publicationTokenData.includes(commitAcknowledgement)
    ) {
      publicationTokenData = '';
      publicationCommitAcknowledged = true;
      void finishReadyCommitConfirmation();
      return;
    }
    const expected = publicationLine(PUBLICATION_HANDLE_ACCEPT, publicationToken);
    if (publicationCommitSent || !publicationTokenData.includes(expected)) return;
    publicationTokenData = '';
    void finishReadyCommit();
  });
  client.on('error', () => {
    if (
      publicationTokenClient === client
      && !exiting
      && !readyPublished
      && !shutdownRequested
    ) {
      reportError('EPIPE', 'publication-token');
    }
  });
  client.on('close', () => {
    if (
      publicationTokenClient === client
      && !exiting
      && !readyPublished
      && !shutdownRequested
    ) {
      reportError('EPIPE', 'publication-token');
    }
  });
};

const acceptReady = async (candidateToken) => {
  if (
    exiting
    || readyPublished
    || readyAcceptanceInProgress
    || !publicationProven
    || !publicationCandidateProof
    || candidateToken !== publicationToken
  ) return;

  readyAcceptanceInProgress = true;
  try {
    // The parent may have observed matching pathname stats before sending this
    // acknowledgement. Re-prove the public endpoint from the held descriptor
    // and this helper's actual listener so a replacement introduced in that
    // gap cannot become a healthy startup.
    const proof = await provePublishedEndpoint();
    if (!samePublicationObject(publicationCandidateProof, proof)) {
      throw new Error('Guardian IPC publication changed before readiness acceptance');
    }
    boundIdentity = proof.descriptorIdentity;

    if (shutdownRequested || !process.connected) {
      exitWithoutPathCleanup(0);
      return;
    }

    readyFramePublished = false;
    const sent = sendMessage(publicationMessage('ready', proof), undefined, (error) => {
      if (error) {
        readyFramePublished = false;
        exitWithoutPathCleanup(1);
      }
    });
    if (!sent) {
      exitWithoutPathCleanup(1);
      return;
    }
    // The JSON frame is not itself readiness. The parent must acknowledge the
    // held accepted-probe token; finishReadyCommit() re-proves the endpoint and
    // emits the commit marker over that token.
    readyFramePublished = true;
  } catch (error) {
    reportError(error?.code || 'EIO', 'ready-accept');
  } finally {
    readyAcceptanceInProgress = false;
  }
};

const startListener = (socketPath, publicationPlatform = process.platform) => {
  if (started) {
    reportError('EALREADY', 'listen');
    return;
  }
  if (typeof socketPath !== 'string' || socketPath.length === 0 || socketPath.includes('\u0000')) {
    reportError('EINVAL', 'listen');
    return;
  }
  if (shutdownRequested || !process.connected) {
    exitWithoutPathCleanup(0);
    return;
  }
  if (!hasPublicationSupport(publicationPlatform)) {
    reportError('ENOTSUP', 'publication');
    return;
  }

  started = true;
  activeSocketPath = socketPath;
  activeOwnerPath = ownerPathFor(socketPath);
  activePublicationPlatform = publicationPlatform;
  publicationInProgress = true;
  listener = net.createServer((socket) => {
    if (exiting) {
      socket.destroy();
      return;
    }

    if (publicationProbe || !publicationProven) {
      acceptPublicationProbeSocket(socket);
      return;
    }

    if (!process.connected) {
      socket.destroy();
      return;
    }

    sendMessage({ type: 'connection' }, socket, (error) => {
      if (error) {
        try { socket.destroy(); } catch { /* The handle may already be transferred. */ }
      }
    });
  });

  let previousUmask;
  try {
    previousUmask = process.umask(DEFAULT_UMASK);
    // Bind on the private owner pathname. The public pathname is absent while
    // libuv creates the listener, so publication can use a no-clobber hard link
    // from the actual bound socket inode instead of trusting a later lstat of
    // the public name.
    listener.listen(activeOwnerPath, async () => {
      process.umask(previousUmask);
      previousUmask = undefined;

      let boundPathDescriptor;
      try {
        // The libuv listener descriptor proves that the bound endpoint is a
        // socket, but its dev/ino belongs to sockfs and is not the filesystem
        // identity of a pathname-backed Unix socket. Bind on the private owner
        // pathname and hold that pathname's filesystem identity instead; the
        // no-clobber hard-link publication below establishes the path/FD
        // relationship without pretending those kernel identities match.
        const bound = readBoundListenerIdentity(activeOwnerPath, undefined, publicationPlatform);
        boundPathDescriptor = bound.descriptor;
        heldBoundPathDescriptor = boundPathDescriptor;

        const boundPathStat = fs.lstatSync(activeOwnerPath);
        const boundPathIdentity = snapshotFileIdentity(boundPathStat);
        if (
          listener.address() !== activeOwnerPath
          || !boundPathStat.isSocket?.()
          || !boundPathIdentity
          || !sameFileIdentity(bound.identity, boundPathIdentity)
        ) {
          throw new Error('bound listener pathname identity unavailable');
        }

        try {
          fs.chmodSync(activeOwnerPath, DEFAULT_SOCKET_MODE);
        } catch {
          reportError('EACCES', 'chmod');
          return;
        }

        // chmod may update ctime on filesystems without birth-time metadata;
        // refresh the held descriptor before publication.
        const refreshedBound = readBoundListenerIdentity(
          activeOwnerPath,
          boundPathDescriptor,
          publicationPlatform,
        );
        const refreshedBoundStat = fs.lstatSync(activeOwnerPath);
        const refreshedBoundPathIdentity = snapshotFileIdentity(refreshedBoundStat);
        if (
          listener.address() !== activeOwnerPath
          || !refreshedBoundStat.isSocket?.()
          || !refreshedBoundPathIdentity
          || !sameFileIdentity(refreshedBound.identity, refreshedBoundPathIdentity)
        ) {
          throw new Error('bound listener pathname identity unavailable');
        }

        // Linux publishes from the held O_PATH descriptor. Other POSIX
        // platforms publish from the checked owner pathname and rely on the
        // actual-listener nonce probe plus the acknowledged handle token below
        // rather than claiming Linux's descriptor-relative link primitive.
        if (publicationPlatform === 'linux') {
          linkFromHeldDescriptor(boundPathDescriptor, activeSocketPath);
        } else {
          linkFromBoundPath(activeOwnerPath, activeSocketPath, refreshedBound.identity);
        }

        // Retain an accepted connection from the actual listener. It is
        // transferred to the parent with the candidate frame and remains the
        // acknowledged readiness token through the final ready handoff.
        const retainedProof = await provePublishedEndpoint({ retain: true });
        const proof = retainedProof.proof;
        publicationToken = randomBytes(32).toString('hex');
        publicationTokenClient = retainedProof.client;
        publicationTokenSocket = retainedProof.socket;
        installPublicationTokenClient(publicationTokenClient);
        publicationCandidateProof = {
          token: publicationToken,
          ...proof,
        };
        boundIdentity = proof.descriptorIdentity;
        publicationProven = true;
      } catch (error) {
        // A public path that appeared before the no-clobber link is the same
        // bind conflict callers would have observed from a direct pathname
        // bind. Keep the transport's existing EADDRINUSE signal while still
        // treating the failed publication as identity-uncertain cleanup.
        const code = error?.code === 'EEXIST' ? 'EADDRINUSE' : error?.code || 'EIO';
        reportError(code, error?.code === 'ENOTSUP' ? 'publication' : 'identity');
        return;
      }

      if (shutdownRequested || !process.connected) {
        exitWithoutPathCleanup(0);
        return;
      }
      const tokenSocket = publicationTokenSocket;
      publicationTokenSocket = null;
      if (!sendMessage(
        publicationMessage('ready-candidate', publicationCandidateProof),
        tokenSocket,
        (error) => {
          if (error) exitWithoutPathCleanup(1);
        },
      )) {
        exitWithoutPathCleanup(1);
        return;
      }
    });
  } catch (error) {
    if (previousUmask !== undefined) process.umask(previousUmask);
    reportError(error?.code || 'ERR_LISTEN', 'listen');
  }

  listener.once('error', (error) => {
    if (previousUmask !== undefined) {
      process.umask(previousUmask);
      previousUmask = undefined;
    }
    reportError(error?.code || 'ERR_LISTEN', 'listen');
  });
};

process.on('disconnect', () => {
  shutdownRequested = true;
  if (!listener || readyPublished) exitWithoutPathCleanup(0);
  else scheduleUnannouncedExit(0);
});

process.on('message', (message) => {
  if (!message || typeof message !== 'object') {
    reportError('EINVAL', 'message');
    return;
  }

  if (message.type === 'listen') {
    startListener(message.socketPath, message.platform || process.platform);
    return;
  }

  if (message.type === 'publication-handle-ready') {
    if (
      message.publicationToken !== publicationToken
      || !publicationTokenClient
      || exiting
    ) return;
    try {
      publicationTokenClient.write(publicationLine(PUBLICATION_HANDLE_MARKER, publicationToken));
    } catch {
      reportError('EPIPE', 'publication-token');
    }
    return;
  }

  if (message.type === 'accept-ready') {
    void acceptReady(message.publicationToken);
    return;
  }

  if (message.type === 'shutdown') {
    shutdownRequested = true;
    if (!listener) exitWithoutPathCleanup(0);
    else if (readyPublished) finishReadyShutdown();
    else scheduleUnannouncedExit(0);
    return;
  }

  reportError('EINVAL', 'message');
});
