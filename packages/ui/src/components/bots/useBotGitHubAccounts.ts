import { useCallback } from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { GITHUB_SOURCE_CONTROL_IDENTITY } from '@/lib/source-control/identity';
import { useBotResource } from './useBotRequest';

export function useBotGitHubAccounts() {
  const { sourceControl } = useRuntimeAPIs();
  const load = useCallback(() => sourceControl.authStatus(GITHUB_SOURCE_CONTROL_IDENTITY), [sourceControl]);
  const read = useBotResource(load);
  return { ...read, accounts: read.data?.accounts?.filter((account) => account.status === 'valid') ?? [] };
}
