import type { DefaultLogFields, LogOptions, LogResult, SimpleGit, SimpleGitTaskCallback } from 'simple-git';
import type { GitFactoryOptions } from './service-contracts.js';

declare module 'simple-git' {
  interface SimpleGitFactory {
    (options: GitFactoryOptions): SimpleGit;
  }

  interface SimpleGit {
    log<Fields = DefaultLogFields>(
      options: Omit<LogOptions<Fields>, 'from' | 'to' | 'file'> & {
        from?: string | undefined;
        to?: string | undefined;
        file?: string | undefined;
      },
      callback?: SimpleGitTaskCallback<LogResult<Fields>>,
    ): SimpleGit & Promise<LogResult<Fields>>;
  }
}
