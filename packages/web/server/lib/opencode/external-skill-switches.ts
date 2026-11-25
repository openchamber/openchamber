import type { ProcessEnvironment } from '../environment/variables.js';
import { isString } from '../shared/guards.js';

const isEnvFlagEnabled = (value: string | undefined) => {
  if (!isString(value)) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== '0' && normalized !== 'false';
};

export const readExternalSkillSwitches = (environment: ProcessEnvironment) => ({
  claudeDisabled: isEnvFlagEnabled(environment.OPENCODE_DISABLE_CLAUDE_CODE)
    || isEnvFlagEnabled(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS),
  allDisabled: isEnvFlagEnabled(environment.OPENCODE_DISABLE_EXTERNAL_SKILLS),
});
