import type { SourceControlRepositoryBinding, SourceControlRepositoryContext } from '../../../../ui/src/lib/source-control/types';

type StoredRemote = SourceControlRepositoryBinding['remotes'][number] extends infer Remote
  ? Remote extends unknown ? Omit<Remote, 'presentation' | 'inherited'> : never
  : never;
type StoredBinding = Omit<SourceControlRepositoryBinding, 'remotes'> & { remotes: StoredRemote[] };

export type BindingStorageSnapshot = {
  version: 2;
  repositories: { [repositoryId: string]: { revision: number; binding: StoredBinding | null } };
};
// These parsers are the persisted and process-boundary entrypoints.
export function parseBinding(value: StoredBinding): StoredBinding;
// `insecureOrigins` is the machine policy's plain-HTTP allowlist as the
// caller resolved it: a response instance may be HTTP on loopback or on one
// of these exact origins.
export function parseBindingResponse(
  value: SourceControlRepositoryBinding,
  options?: { insecureOrigins?: readonly string[] },
): SourceControlRepositoryBinding;
export function parseBindingStore(value: BindingStorageSnapshot): BindingStorageSnapshot;
export function isSafeRepositoryEndpoint(value: SourceControlRepositoryContext['remotes'][number]['fetch']): boolean;
export function bindingSummary(binding: Pick<SourceControlRepositoryBinding, 'providers' | 'remotes' | 'auxiliary'>): SourceControlRepositoryBinding['state'];
export function resolveBindingReadiness(binding: SourceControlRepositoryBinding, repository: SourceControlRepositoryContext): SourceControlRepositoryBinding;
