import { isDeepStrictEqual } from 'node:util';
import type { BindingRead } from '../source-control/binding-service-contracts.js';
import type { RepositoryAuthority } from './network-execution-contracts.js';
import type { CheckoutHydration, PlannedRemote } from './service-contracts.js';

type ReadBinding = (directory: string, plannedRemote?: PlannedRemote) => Promise<BindingRead>;
interface PinnedAuthority { authority: RepositoryAuthority; step: number }

const queues = new Map<string, Promise<void>>();
const additions = new Map<string, { configRevision: string; step: number }>();
let lastStep = 0;

const additionKey = ({ repositoryId, bindingRevision, configRevision }: RepositoryAuthority) =>
  JSON.stringify([repositoryId, bindingRevision, configRevision]);

const authorityOf = (read: BindingRead): RepositoryAuthority => ({
  repositoryId: read.repository.repositoryId,
  bindingRevision: read.revision,
  configRevision: read.repository.configRevision,
});

const enqueue = async <Result>(repositoryId: string, task: () => Promise<Result>) => {
  const current = (queues.get(repositoryId) ?? Promise.resolve()).then(task);
  const tail = current.then(() => undefined, () => undefined);
  queues.set(repositoryId, tail);
  try {
    return await current;
  } finally {
    if (queues.get(repositoryId) === tail) queues.delete(repositoryId);
  }
};

const hasRemote = (read: BindingRead, name: string) => read.repository.remotes.some((remote) => remote.name === name);

export const createWithPlannedRemote = async <Result>({ directory, remote, serialize, readBinding, create }: {
  directory: string;
  remote: PlannedRemote | undefined;
  serialize: boolean;
  readBinding: ReadBinding;
  create(pinned: PinnedAuthority): Promise<Result>;
}): Promise<Result> => {
  const step = lastStep;
  const current = await readBinding(directory, remote && !serialize ? remote : undefined);
  if (!remote || !serialize || hasRemote(current, remote.name)) return create({ authority: authorityOf(current), step });
  return enqueue(current.repository.repositoryId, async () => {
    const pinnedAt = lastStep;
    const plannedRead = await readBinding(directory, remote);
    const planned = authorityOf(plannedRead);
    const read = await readBinding(directory);
    const before = authorityOf(read);
    const result = await create({ authority: planned, step: pinnedAt });
    const others = plannedRead.repository.remotes.filter(({ name }) => name !== remote.name);
    const added = before.configRevision !== planned.configRevision
      && !hasRemote(read, remote.name) && isDeepStrictEqual(others, read.repository.remotes);
    if (added && before.bindingRevision === planned.bindingRevision) {
      lastStep += 1;
      additions.set(additionKey(before), { configRevision: planned.configRevision, step: lastStep });
    }
    return result;
  });
};

const isStale = <Code>(code: Code) => code === 'STALE_BINDING' || code === 'SOURCE_CONTROL_BINDING_STALE';
const hasErrorCode = (value: unknown): value is Error & { code: unknown } => value instanceof Error && 'code' in value;

type HydrationAttempt = { stale: boolean } & ({ result: CheckoutHydration | null | undefined } | { error: Error });

export const hydrateFollowingPlannedRemotes = async (
  { authority: pinned, step }: PinnedAuthority,
  hydrate: (authority: RepositoryAuthority) => Promise<CheckoutHydration | null | undefined>,
) => {
  const advance = async (authority: RepositoryAuthority) => {
    await queues.get(authority.repositoryId);
    const addition = additions.get(additionKey(authority));
    return addition && addition.step > step ? { ...authority, configRevision: addition.configRevision } : null;
  };
  let authority = pinned;
  while (true) {
    let attempt: HydrationAttempt;
    try {
      const result = await hydrate(authority);
      attempt = { result, stale: result?.status === 'failed' && [...result.submodules, ...result.lfs].some(({ error }) => isStale(error?.code)) };
    } catch (error) {
      if (!hasErrorCode(error) || !isStale(error.code)) throw error;
      attempt = { error, stale: true };
    }
    const next = attempt.stale ? await advance(authority) : null;
    if (next) authority = next;
    else if ('error' in attempt) throw attempt.error;
    else return attempt.result;
  }
};
