import type { ProcessEnvironment } from '../environment/variables.js';

type ExternalSkillSwitches = { claudeDisabled: boolean };

type SkillListResponse<T> = {
  skills: T[];
  externalSkills?: ExternalSkillSwitches;
  openCodeSkillsUnavailable?: true;
};

const isEnvFlagEnabled = (value: string | undefined) => value === '1' || value?.toLowerCase() === 'true';

const readExternalSkillSwitches = (environment: ProcessEnvironment): ExternalSkillSwitches => ({
  claudeDisabled: isEnvFlagEnabled(environment.OPENCODE_DISABLE_CLAUDE_CODE)
    || isEnvFlagEnabled(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS),
});

export const buildSkillListResponse = <T>(
  skills: T[],
  launchEnvironment: ProcessEnvironment | null,
  openCodeSkillsUnavailable: boolean,
): SkillListResponse<T> => {
  const response: SkillListResponse<T> = { skills };
  if (launchEnvironment) response.externalSkills = readExternalSkillSwitches(launchEnvironment);
  if (openCodeSkillsUnavailable) response.openCodeSkillsUnavailable = true;
  return response;
};
