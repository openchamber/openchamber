import { normalizePath } from '@/lib/pathNormalization';

/**
 * `host.openCommit` on the phone: the commit is selected under `directory`,
 * the repository the extension read it from. Changes shows it in its commit
 * scope once that repository is the one on screen.
 */
export type MobileChangesCommitRequest = { readonly scope: 'commit'; readonly directory: string };

const normalized = (path: string): string => normalizePath(path) ?? path;

/**
 * The repository Changes switches to for the request: the folder itself, or a
 * repository inside it. Null for one outside the folder, which Changes cannot
 * show, so the commit scope never opens on another repository's selection.
 */
export const commitRequestRepository = (rootDirectory: string, request: MobileChangesCommitRequest): string | null => {
  const root = normalized(rootDirectory);
  const target = normalized(request.directory);
  if (!root) return null;
  if (target === root) return root;
  return target.startsWith(root.endsWith('/') ? root : `${root}/`) ? target : null;
};

/** Whether Changes now shows the repository the request selected its commit in. */
export const commitRequestShown = (currentDirectory: string, request: MobileChangesCommitRequest): boolean => (
  Boolean(currentDirectory) && normalized(currentDirectory) === normalized(request.directory)
);
