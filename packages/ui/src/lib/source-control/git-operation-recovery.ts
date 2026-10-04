import { z } from 'zod';
import type { GitAPI, GitNetworkOperation, GitNetworkOperationPlan, GitNetworkOperationRequest } from '@/lib/api/types';
import type { GitOperationRead } from '@/lib/boundGitNetworkOperation';

const STORAGE_KEY = 'openchamber.git.pending-operations.v1';
const MAX_REFERENCES = 64;
const text = z.string().min(1).max(512);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const referenceSchema = z.object({
  runtimeKey: digestSchema,
  runtimeIdentity: z.object({ id: text, platform: z.enum(['web', 'desktop', 'vscode']) }).strict(),
  repositoryId: text.nullable(),
  operationId: text,
  operation: z.enum(['push', 'pull', 'fetch', 'sync', 'delete-remote-branch', 'clone', 'checkout-hydration']),
  targetDigest: digestSchema,
  durableTargetDigest: digestSchema.optional(),
}).strict().refine((value) => (value.operation === 'clone') === (value.repositoryId === null));
const storageSchema = z.object({ version: z.literal(1), references: z.array(referenceSchema).max(MAX_REFERENCES) }).strict();

export type PendingGitReference = z.infer<typeof referenceSchema>;
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;
type RecoverySnapshot = {
  ready: boolean;
  references: PendingGitReference[];
  problem: 'storage' | 'capacity' | null;
};

export class PendingGitOperationError extends Error {
  constructor(readonly reason: 'storage' | 'capacity' | 'pending', readonly references: PendingGitReference[] = []) {
    super(reason);
    this.name = 'PendingGitOperationError';
  }
}

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotateRight = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

const digest = async (value: string): Promise<string> => {
  const input = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = await subtle.digest('SHA-256', input);
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // FIPS 180-4 sections 5 and 6.2. Plain HTTP lacks SubtleCrypto, but must match
  // existing v1 fingerprints exactly. This is not an authentication/credential primitive.
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    for (const [index, word] of [a, b, c, d, e, f, g, h].entries()) state[index] = (state[index] + word) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
};

// Keep target equality stable across the server's durable public-snapshot redaction.
const durableTargetText = (target: GitNetworkOperation['target']): string => JSON.stringify(target, (key, value) => {
  if (key === 'forceWithLease') return undefined;
  if (key !== 'displayUrl') return value;
  const displayUrl = z.string().safeParse(value);
  if (!displayUrl.success || displayUrl.data.includes('://')) return value;
  const match = displayUrl.data.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  return match ? `${match[1]}:${match[2]}` : displayUrl.data;
});

export const createGitOperationRecoveryOwner = (storage: () => RecoveryStorage) => {
  let snapshot: RecoverySnapshot = { ready: false, references: [], problem: null };
  const listeners = new Set<() => void>();
  const reservations = new Set<string>();
  const reconciling = new Map<string, Promise<GitOperationRead | null>>();
  const publish = (next: RecoverySnapshot) => {
    if (snapshot.ready === next.ready && snapshot.problem === next.problem
      && JSON.stringify(snapshot.references) === JSON.stringify(next.references)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const failStorage = (): never => {
    publish({ ...snapshot, ready: false, problem: 'storage' });
    throw new PendingGitOperationError('storage', snapshot.references);
  };
  const hash = async (value: string): Promise<string> => {
    try { return await digest(value); } catch { return failStorage(); }
  };
  const load = (): PendingGitReference[] => {
    try {
      const encoded = storage().getItem(STORAGE_KEY);
      if (encoded !== null && encoded.length > 256 * 1024) return failStorage();
      const references = encoded === null ? [] : storageSchema.parse(JSON.parse(encoded)).references;
      const ids = references.map((reference) => JSON.stringify([reference.runtimeKey, reference.runtimeIdentity, reference.operationId]));
      if (new Set(ids).size !== ids.length) return failStorage();
      publish({ ready: true, references, problem: references.length >= MAX_REFERENCES ? 'capacity' : null });
      return references;
    } catch { return failStorage(); }
  };
  const save = (references: PendingGitReference[]) => {
    try {
      storage().setItem(STORAGE_KEY, JSON.stringify({ version: 1, references }));
    } catch { return failStorage(); }
    publish({ ready: true, references, problem: references.length >= MAX_REFERENCES ? 'capacity' : null });
  };
  const matches = async (reference: PendingGitReference, runtimeKey: string, operation: GitNetworkOperation): Promise<boolean> => {
    if (operation.target.operation === 'clone' && operation.state === 'partial' && !operation.completedSteps.includes('checked-out')) return false;
    if (operation.target.operation === 'sync' && operation.state === 'succeeded') {
      const steps = operation.stepResults;
      if (!steps || steps.length !== 3 || !['fetch', 'pull', 'push'].every((step) => steps.some((result) => result.step === step && result.status === 'succeeded'))) return false;
    }
    const targetDigest = await hash(JSON.stringify(operation.target));
    const durableTargetDigest = await hash(durableTargetText(operation.target));
    return reference.runtimeKey === await hash(runtimeKey)
      && reference.operationId === operation.operationId
      && reference.runtimeIdentity.id === operation.runtimeIdentity.id
      && reference.runtimeIdentity.platform === operation.runtimeIdentity.platform
      && reference.repositoryId === ('repositoryId' in operation.target ? operation.target.repositoryId : null)
      && reference.operation === operation.target.operation
      && (reference.targetDigest === targetDigest || reference.durableTargetDigest === durableTargetDigest);
  };

  const remember = async (runtimeKey: string, operation: GitNetworkOperationPlan): Promise<void> => {
    const reference = referenceSchema.parse({
      runtimeKey: await hash(runtimeKey),
      runtimeIdentity: { id: operation.runtimeIdentity.id, platform: operation.runtimeIdentity.platform },
      repositoryId: 'repositoryId' in operation.target ? operation.target.repositoryId : null,
      operationId: operation.operationId,
      operation: operation.target.operation,
      targetDigest: await hash(JSON.stringify(operation.target)),
      durableTargetDigest: await hash(durableTargetText(operation.target)),
    });
    const references = load();
    const existing = references.find((item) => item.runtimeKey === reference.runtimeKey && item.operationId === reference.operationId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(reference)) throw new PendingGitOperationError('pending', [existing]);
      save(references);
      return;
    }
    if (references.length >= MAX_REFERENCES) throw new PendingGitOperationError('capacity', references);
    save([...references, reference]);
  };

  const complete = async (read: GitOperationRead, isCurrent: () => boolean = () => true): Promise<void> => {
    if (read.availability !== 'available' || ['planned', 'running', 'outcome-unknown'].includes(read.operation.state)) return;
    const runtimeKey = await hash(read.runtimeKey);
    const references = load();
    const candidate = references.find((reference) => reference.runtimeKey === runtimeKey && reference.operationId === read.operation.operationId);
    if (!candidate || !await matches(candidate, read.runtimeKey, read.operation) || !isCurrent()) return;
    // Re-read after digest work so another operation's intervening write cannot be lost.
    save(load().filter((reference) => JSON.stringify(reference) !== JSON.stringify(candidate)));
  };

  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    runtimeKey: hash,
    hydrate: () => { try { load(); } catch { /* The snapshot exposes the fail-closed storage state. */ } },
    assertWritable: () => {
      const references = load();
      if (references.length + reservations.size >= MAX_REFERENCES) throw new PendingGitOperationError('capacity', references);
      save(references);
    },
    plan: async (git: Pick<GitAPI, 'planNetworkOperation'>, request: GitNetworkOperationRequest, runtimeKey: string, isCurrent: () => boolean): Promise<GitNetworkOperationPlan> => {
      const key = await hash(runtimeKey);
      if (!isCurrent()) throw new PendingGitOperationError('pending');
      const repositoryId = request.operation === 'clone' ? null : request.repositoryId;
      const scope = JSON.stringify([key, repositoryId]);
      const references = load();
      const pending = references.filter((reference) => reference.runtimeKey === key && reference.repositoryId === repositoryId);
      if (pending.length || reservations.has(scope)) throw new PendingGitOperationError('pending', pending);
      if (references.length + reservations.size >= MAX_REFERENCES) throw new PendingGitOperationError('capacity', references);
      // Plan creates only an unexecuted server record. Confirm storage is writable before even creating that record.
      save(references);
      reservations.add(scope);
      try {
        const plan = await git.planNetworkOperation(request);
        await remember(runtimeKey, plan);
        return plan;
      } finally { reservations.delete(scope); }
    },
    remember,
    complete,
    reconcile: (reference: PendingGitReference, git: Pick<GitAPI, 'getNetworkOperation'>, runtimeKey: string, isCurrent: () => boolean): Promise<GitOperationRead | null> => {
      const key = JSON.stringify(reference);
      const existing = reconciling.get(key);
      if (existing) return existing;
      const request = (async () => {
        try {
          if (!isCurrent() || await hash(runtimeKey) !== reference.runtimeKey || !isCurrent()) return null;
          const operation = await git.getNetworkOperation(reference.operationId);
          if (!isCurrent() || !await matches(reference, runtimeKey, operation) || !isCurrent()) return null;
          const read: GitOperationRead = { runtimeKey, operation, availability: 'available' };
          try { await complete(read, isCurrent); } catch { /* Keep the proven result visible while its durable blocker remains. */ }
          return read;
        } catch {
          // NOT_FOUND after a server restart is an unknown outcome, not success or a failed mutation.
          return null;
        }
      })().finally(() => { reconciling.delete(key); });
      reconciling.set(key, request);
      return request;
    },
  };
};

export const gitOperationRecoveryOwner = createGitOperationRecoveryOwner(() => window.sessionStorage);
