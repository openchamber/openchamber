import React from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { listTaskRepositories } from '@/lib/multiRepoTasks';

type TaskRepositoryListing =
  | { status: 'loading' }
  | { status: 'loaded'; repositories: string[] }
  | { status: 'failed'; message: string };

export const useTaskRepositories = (reposDirInput: string): TaskRepositoryListing => {
  const reposDir = useDebouncedValue(reposDirInput.trim(), 250);
  const [listing, setListing] = React.useState<TaskRepositoryListing>({ status: 'loading' });

  React.useEffect(() => {
    if (!reposDir) return;
    let cancelled = false;
    setListing({ status: 'loading' });
    listTaskRepositories(reposDir).then(
      (repositories) => { if (!cancelled) setListing({ status: 'loaded', repositories }); },
      (cause: unknown) => { if (!cancelled) setListing({ status: 'failed', message: cause instanceof Error ? cause.message : String(cause) }); },
    );
    return () => { cancelled = true; };
  }, [reposDir]);

  return listing;
};
