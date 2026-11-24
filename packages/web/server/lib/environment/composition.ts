import { configureGitEnvironment } from '../git/service.js';
import { configureClaudeCredentialEnvironment } from '../quota/providers/claude/auth.js';
import { createEnvironmentRuntime } from './runtime.js';

export const composeEnvironmentRuntime = (options: Parameters<typeof createEnvironmentRuntime>[0]) => {
  const runtime = createEnvironmentRuntime(options);
  configureGitEnvironment(runtime);
  configureClaudeCredentialEnvironment(() => runtime.forClaudeQuota());
  return runtime;
};
