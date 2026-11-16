import { normalizePath } from '@/lib/pathNormalization';

export type MobileChangesCommitRequest = { readonly scope: 'commit'; readonly directory: string };

const normalized = (path: string): string => normalizePath(path) ?? path;

export const commitRequestRepository = (rootDirectory: string, request: MobileChangesCommitRequest): string | null => {
  const root = normalized(rootDirectory);
  const target = normalized(request.directory);
  if (!root) return null;
  if (target === root) return root;
  return target.startsWith(root.endsWith('/') ? root : `${root}/`) ? target : null;
};

export const commitRequestShown = (currentDirectory: string, request: MobileChangesCommitRequest): boolean => (
  Boolean(currentDirectory) && normalized(currentDirectory) === normalized(request.directory)
);
