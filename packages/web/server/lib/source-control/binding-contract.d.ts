import type { SourceControlRepositoryBinding, SourceControlRepositoryContext } from '../../../../ui/src/lib/source-control/types';

type StoredRemote = SourceControlRepositoryBinding['remotes'][number] extends infer Remote
  ? Remote extends { presentation?: unknown } ? Omit<Remote, 'presentation'> : Remote
  : never;
type StoredBinding = Omit<SourceControlRepositoryBinding, 'remotes'> & { remotes: StoredRemote[] };

export type BindingStorageSnapshot = {
  version: 2;
  repositories: { [repositoryId: string]: { revision: number; binding: StoredBinding | null } };
};
// These parsers are the persisted and process-boundary entrypoints.
export function parseBinding(value: StoredBinding): StoredBinding;
export function parseBindingResponse(value: SourceControlRepositoryBinding): SourceControlRepositoryBinding;
export function parseBindingStore(value: BindingStorageSnapshot): BindingStorageSnapshot;
export function isSafeRepositoryEndpoint(value: SourceControlRepositoryContext['remotes'][number]['fetch']): boolean;
export function bindingSummary(binding: Pick<SourceControlRepositoryBinding, 'providers' | 'remotes' | 'auxiliary'>): SourceControlRepositoryBinding['state'];
export function resolveBindingReadiness(binding: SourceControlRepositoryBinding, repository: SourceControlRepositoryContext): SourceControlRepositoryBinding;
