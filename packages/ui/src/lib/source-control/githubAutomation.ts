import type { SourceControlIdentity } from './types';

/** The fork's stack runner and fix-loop service accept github.com bound contexts only. */
export const supportsGitHubAutomation = (identity: SourceControlIdentity | null | undefined): boolean => (
  identity?.provider === 'github' && identity.instance === 'github.com'
);
