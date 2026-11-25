export interface GitWorktreeValidationError {
  code: string;
  message: string;
  setupFailed?: boolean;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: GitWorktreeValidationError[];
  resolved?: {
    mode?: 'new' | 'existing';
    localBranch?: string | null;
  };
}
