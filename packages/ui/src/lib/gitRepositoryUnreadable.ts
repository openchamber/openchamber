export const GIT_REPOSITORY_UNREADABLE = 'GIT_REPOSITORY_UNREADABLE';

export class GitRepositoryUnreadableError extends Error {
  readonly code = GIT_REPOSITORY_UNREADABLE;

  constructor(message: string) {
    super(message);
    this.name = 'GitRepositoryUnreadableError';
  }
}
