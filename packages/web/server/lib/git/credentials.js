import fs from 'fs';
import fsp from 'node:fs/promises';
import path from 'path';
import os from 'os';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  createSshCredentialReference,
  inspectManagedSshCredential,
  parseGitCredentialReference,
  snapshotSshPrivateKey,
} from './credential-resolver.js';


const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const likelyPrivateKeyName = (name) => /^(?:id_[A-Za-z0-9._-]+|identity)$/i.test(name) && !name.endsWith('.pub');
const statIdentity = (stats) => `${stats.dev}:${stats.ino}`;
const removeOwnedFile = async (filePath, identity, fsImpl) => {
  try {
    if (statIdentity(await fsImpl.stat(filePath)) !== identity) return false;
    await fsImpl.rm(filePath, { force: true });
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
};
const copyVerifiedSnapshot = async (snapshot, destinationPath, fsImpl) => {
  let sourceHandle;
  let destinationHandle;
  let destinationIdentity;
  let privateKey;
  try {
    sourceHandle = await fsImpl.open(snapshot.privateKeyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (statIdentity(await sourceHandle.stat()) !== snapshot.snapshotIdentity) {
      throw new Error('Managed SSH key snapshot changed');
    }
    privateKey = await sourceHandle.readFile();
    destinationHandle = await fsImpl.open(destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    destinationIdentity = statIdentity(await destinationHandle.stat());
    await destinationHandle.writeFile(privateKey);
    await destinationHandle.chmod(0o600);
    return destinationIdentity;
  } catch (error) {
    await destinationHandle?.close().catch(() => {});
    destinationHandle = null;
    if (destinationIdentity && !await removeOwnedFile(destinationPath, destinationIdentity, fsImpl)) {
      throw new Error('Managed SSH credential copy rollback failed');
    }
    throw error;
  } finally {
    privateKey?.fill(0);
    await sourceHandle?.close().catch(() => {});
    await destinationHandle?.close().catch(() => {});
  }
};

export function createManagedSshInventory({
  store,
  snapshotRoot,
  discoveryRoot,
  managedKeyRoot,
  fsImpl = fsp,
  executeFile,
  now = Date.now,
  idFactory = randomUUID,
  candidateTtlMs = 5 * 60_000,
  candidateLimit = 256,
  discoveryEntryLimit = 128,
} = {}) {
  if (!store || !path.isAbsolute(snapshotRoot) || !path.isAbsolute(discoveryRoot) || !path.isAbsolute(managedKeyRoot)
    || !Number.isSafeInteger(candidateTtlMs) || candidateTtlMs < 1
    || !Number.isSafeInteger(candidateLimit) || candidateLimit < 1
    || !Number.isSafeInteger(discoveryEntryLimit) || discoveryEntryLimit < 1) {
    throw new TypeError('Managed SSH inventory configuration is invalid');
  }
  const candidates = new Map();
  const inUseCandidates = new Set();
  const pruneExpiredCandidates = () => {
    const current = now();
    for (const [id, candidate] of candidates) {
      if (candidate.expiresAt <= current) candidates.delete(id);
    }
  };
  const makeCandidateSpace = () => {
    pruneExpiredCandidates();
    while (candidates.size >= candidateLimit) candidates.delete(candidates.keys().next().value);
  };
  const inspectRecord = async (record, deadline = now() + 10_000) => {
    if (!SAFE_ID.test(record.id)) throw new Error('Managed SSH credential ID is invalid');
    return { credentialId: createSshCredentialReference(record.id), label: 'SSH', fingerprint: record.fingerprint,
      capability: await inspectManagedSshCredential(record, { snapshotRoot, fsImpl, executeFile, deadline }) };
  };
  const inventoryFromState = async ({ keys }) => {
    if (keys.length > 256) throw new Error('Managed SSH inventory exceeds the supported limit');
    const credentials = [];
    const deadline = now() + 10_000;
    for (const record of keys) {
      credentials.push(await inspectRecord(record, deadline));
      if (now() >= deadline) throw new Error('Managed SSH inventory timed out');
    }
    return credentials;
  };
  const inventory = async () => ({ status: 'available', credentials: await inventoryFromState(await store.read()) });

  const discover = async () => {
    pruneExpiredCandidates();
    let approvedRoot;
    let directory;
    try {
      const configuredRoot = await fsImpl.lstat(discoveryRoot);
      if (!configuredRoot.isDirectory() || configuredRoot.isSymbolicLink()) {
        throw new Error('Managed SSH discovery root is invalid');
      }
      approvedRoot = await fsImpl.realpath(discoveryRoot);
      directory = await fsImpl.opendir(approvedRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'discovered', candidates: [], truncated: false };
      throw error;
    }
    const entries = [];
    let truncated = false;
    try {
      for await (const entry of directory) {
        if (entries.length >= discoveryEntryLimit) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
    } finally {
      try {
        // The async iterator closes the directory when it finishes, so this is
        // the second close; Node rejects with ERR_DIR_CLOSED and Bun returns
        // undefined rather than a promise, and both mean the same thing.
        await directory.close();
      } catch (error) {
        if (error?.code !== 'ERR_DIR_CLOSED') throw error;
      }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const discovered = [];
    const deadline = now() + 10_000;
    for (const entry of entries) {
      if (now() >= deadline) throw new Error('Managed SSH credential discovery timed out');
      const label = SAFE_LABEL.test(entry.name) ? entry.name : null;
      if (!label) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let snapshot;
      try {
        snapshot = await snapshotSshPrivateKey({
          privateKeyPath: path.join(approvedRoot, entry.name),
          realpath: fsImpl.realpath,
          execute: executeFile,
          fsImpl,
          snapshotRoot,
          operationId: `discover_${idFactory()}`,
          deadline,
          approvedRoot,
          requirePrivateMode: true,
          rejectSymlinkPath: true,
        });
        if (!await snapshot.cleanup()) throw new Error('Managed SSH credential discovery cleanup failed');
        const candidateId = `ssh_candidate_${idFactory().replaceAll('-', '_')}`;
        makeCandidateSpace();
        candidates.set(candidateId, Object.freeze({
          candidateId,
          sourcePath: snapshot.sourcePath,
          sourceIdentity: snapshot.sourceIdentity,
          fingerprint: snapshot.fingerprint,
          label,
          approvedRoot,
          expiresAt: now() + candidateTtlMs,
        }));
        discovered.push({ candidateId, label, fingerprint: snapshot.fingerprint, capability: { status: 'ready' } });
      } catch (error) {
        if (snapshot && !await snapshot.cleanup()) throw new Error('Managed SSH credential discovery cleanup failed');
        if (error?.code === 'SSH_KEY_NOT_PRIVATE' || error?.code === 'SSH_KEY_CHANGED') continue;
        if (error?.code === 'SSH_KEY_INSECURE_PERMISSIONS') {
          discovered.push({ label, capability: { status: 'unavailable', reason: 'insecure-permissions' } });
          continue;
        }
        if (error?.code === 'SSH_KEY_UNVERIFIABLE') {
          discovered.push({ label, capability: { status: 'unavailable', reason: 'encrypted-or-unverifiable' } });
          continue;
        }
        if (error?.code === 'SSH_KEY_UNREADABLE' && likelyPrivateKeyName(entry.name)) {
          discovered.push({ label, capability: { status: 'unavailable', reason: 'unreadable' } });
          continue;
        }
        if (error?.code === 'SSH_KEY_UNREADABLE') continue;
        throw error;
      }
    }
    return { status: 'discovered', candidates: discovered, truncated };
  };

  const importCandidate = async ({ candidateId, expectedFingerprint, confirmed } = {}) => {
    if (confirmed !== true || !SAFE_ID.test(candidateId) || !SSH_FINGERPRINT.test(expectedFingerprint)) {
      throw new Error('Managed SSH credential import is invalid');
    }
    pruneExpiredCandidates();
    const candidate = candidates.get(candidateId);
    if (!candidate || candidate.expiresAt <= now()) return { status: 'rejected', reason: 'candidate-expired' };
    if (inUseCandidates.has(candidateId)) return { status: 'rejected', reason: 'candidate-unavailable' };
    if (candidate.fingerprint !== expectedFingerprint) return { status: 'rejected', reason: 'fingerprint-mismatch' };
    inUseCandidates.add(candidateId);
    let snapshot;
    let managedKeyPath;
    let managedKeyIdentity;
    let recordCommitted = false;
    try {
      try {
        snapshot = await snapshotSshPrivateKey({
          privateKeyPath: candidate.sourcePath,
          realpath: fsImpl.realpath,
          execute: executeFile,
          fsImpl,
          snapshotRoot,
          operationId: `import_${idFactory()}`,
          deadline: now() + 10_000,
          approvedRoot: candidate.approvedRoot,
          expectedSourceIdentity: candidate.sourceIdentity,
          requirePrivateMode: true,
          rejectSymlinkPath: true,
        });
      } catch (error) {
        candidates.delete(candidateId);
        if (error?.code === 'SSH_KEY_CHANGED' || error?.code === 'SSH_KEY_INSECURE_PERMISSIONS') {
          return { status: 'rejected', reason: 'candidate-changed' };
        }
        if (['SSH_KEY_UNREADABLE', 'SSH_KEY_UNVERIFIABLE', 'SSH_KEY_NOT_PRIVATE'].includes(error?.code)) {
          return { status: 'rejected', reason: 'candidate-unavailable' };
        }
        throw error;
      }
      if (snapshot.fingerprint !== expectedFingerprint) {
        candidates.delete(candidateId);
        return { status: 'rejected', reason: 'candidate-changed' };
      }
      await fsImpl.mkdir(managedKeyRoot, { recursive: true, mode: 0o700 });
      const managedRootStats = await fsImpl.lstat(managedKeyRoot);
      if (!managedRootStats.isDirectory() || managedRootStats.isSymbolicLink()) {
        throw new Error('Managed SSH private key directory is invalid');
      }
      if (process.platform !== 'win32') await fsImpl.chmod(managedKeyRoot, 0o700);
      const recordId = `ssh_${idFactory().replaceAll('-', '_')}`;
      managedKeyPath = path.join(managedKeyRoot, `${recordId}.key`);
      managedKeyIdentity = await copyVerifiedSnapshot(snapshot, managedKeyPath, fsImpl);
      if (!await snapshot.cleanup()) throw new Error('Managed SSH credential import cleanup failed');
      snapshot = null;
      let state;
      try {
        state = await store.append({ id: recordId, privateKeyPath: managedKeyPath, fingerprint: expectedFingerprint });
      } catch (error) {
        if (error?.managedSshRecordCommitted === true) {
          recordCommitted = true;
          candidates.delete(candidateId);
          throw error;
        }
        if (!await removeOwnedFile(managedKeyPath, managedKeyIdentity, fsImpl)) {
          throw new Error('Managed SSH credential import rollback failed');
        }
        managedKeyPath = null;
        if (error?.code === 'MANAGED_SSH_CREDENTIAL_LIMIT') return { status: 'rejected', reason: 'inventory-full' };
        throw error;
      }
      recordCommitted = true;
      candidates.delete(candidateId);
      const credentials = await inventoryFromState(state);
      const selectedCredential = credentials.find((credential) => credential.credentialId === createSshCredentialReference(recordId));
      if (!selectedCredential) throw new Error('Imported managed SSH credential is unavailable');
      return { status: 'imported', credentials, selectedCredential };
    } finally {
      inUseCandidates.delete(candidateId);
      if (snapshot && !await snapshot.cleanup()) throw new Error('Managed SSH credential import cleanup failed');
      if (!recordCommitted && managedKeyPath && managedKeyIdentity
        && !await removeOwnedFile(managedKeyPath, managedKeyIdentity, fsImpl)) {
        throw new Error('Managed SSH credential import rollback failed');
      }
    }
  };

  return Object.freeze({
    inventory,
    discover,
    import: importCandidate,
    assertAvailable: async (credentialId) => {
      let reference;
      try { reference = parseGitCredentialReference(credentialId); } catch { throw new Error('Managed SSH credential reference is invalid'); }
      if (reference.transport !== 'ssh') throw new Error('Managed SSH credential reference is required');
      const record = await store.lookup(reference.keyId);
      if (!record || (await inspectRecord(record)).capability.status !== 'ready') {
        throw new Error('Managed SSH credential is unavailable. Configure it on the connected server or explicitly select System transport.');
      }
    },
    presentation: async (credentialId, deadline = now() + 10_000) => {
      let reference;
      try { reference = parseGitCredentialReference(credentialId); } catch { return null; }
      if (reference.transport !== 'ssh') return null;
      const record = await store.lookup(reference.keyId);
      if (!record) return null;
      const inspected = await inspectRecord(record, deadline);
      return inspected.capability.status === 'ready' ? Object.freeze({ fingerprint: inspected.fingerprint }) : null;
    },
  });
}

