/**
 * Provider-agnostic git-forge facade.
 *
 * Barrel for the forge contract: normalized entity types (`./types`), the
 * `ForgeProvider` interface + capability model (`./provider`), the pure
 * normalization mappers (`./normalize`), and the per-provider adapters +
 * factory (`./adapters`).
 */

export type {
  ForgeIssue,
  ForgeCommit,
  ForgeFileChange,
} from './types';

export {
  buildForgeProvider,
} from './adapters';

export {
  mapGithubPr,
} from './normalize';
