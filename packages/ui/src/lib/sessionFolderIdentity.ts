/**
 * Folder ids are unique only inside their persisted directory scope. This
 * identity is used for UI-only state such as folder collapse; folder records
 * and store APIs continue to use the bare folder UUID.
 */
export const getSessionFolderIdentityKey = (scopeKey: string, folderId: string): string => (
  `${scopeKey}\u0000${folderId}`
);

/**
 * The single canonical archived-scope contract: the reserved scope prefix, the
 * archived scope-key builder, and the archived-scope predicate. Scope-key
 * guards must use `isArchivedFolderScope`, not an ad-hoc `startsWith`, so the
 * prefix constant and its meaning stay in one place.
 */
export const ARCHIVED_FOLDER_SCOPE_PREFIX = '__archived__:';

export const getArchivedScopeKey = (projectRoot: string): string => `${ARCHIVED_FOLDER_SCOPE_PREFIX}${projectRoot}`;

export const isArchivedFolderScope = (scopeKey: string): boolean => (
  scopeKey.startsWith(ARCHIVED_FOLDER_SCOPE_PREFIX)
  && scopeKey.length > ARCHIVED_FOLDER_SCOPE_PREFIX.length
);
