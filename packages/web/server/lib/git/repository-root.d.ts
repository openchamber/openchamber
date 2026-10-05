export function unsupportedRepositoryRootReason(repoRoot: string, home?: string): 'filesystem-root' | 'home' | null;
export function vcsInitRefusal(
  method: string,
  requestUrl: string,
  headers: Record<string, string | string[] | undefined> | undefined,
  home?: string,
): string | null;
export function vcsInitRefusalBody(message: string): { _tag: 'InvalidRequestError'; message: string; field: 'location' };
