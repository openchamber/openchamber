/**
 * The error a repository check fails with when Git itself could not answer
 * (not startable, a refused `safe.directory`, a timeout). Its message is Git's
 * own text. Every runtime reports it with this code (the web server in its
 * JSON body, the VS Code bridge on the bridge error), and each runtime's
 * adapter throws it as `GitRepositoryUnreadableError`.
 */
export const GIT_REPOSITORY_UNREADABLE = 'GIT_REPOSITORY_UNREADABLE';

export class GitRepositoryUnreadableError extends Error {
  readonly code = GIT_REPOSITORY_UNREADABLE;

  constructor(message: string) {
    super(message);
    this.name = 'GitRepositoryUnreadableError';
  }
}
