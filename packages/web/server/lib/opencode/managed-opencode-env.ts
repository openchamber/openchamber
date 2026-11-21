import { applyProviderEnvAliases } from './provider-env-aliases.js';

const OPENCODE_CLIENT_NAME = 'openchamber';

export const prepareManagedOpenCodeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...applyProviderEnvAliases(env),
  OPENCODE_CLIENT: OPENCODE_CLIENT_NAME,
});
