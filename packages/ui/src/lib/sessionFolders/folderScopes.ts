/** The folder scope of a project's archived chats, beside its root and worktree scopes. */
export const getArchivedScopeKey = (projectRoot: string): string => `__archived__:${projectRoot}`;
