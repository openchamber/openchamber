import { discoverSkills, isManagedSkillPath, mergeDiscoveredSkills, type DiscoveredSkill } from './opencodeConfig';
import { buildSkillListResponse } from '../../web/server/lib/opencode/external-skill-switches.js';

export const buildSkillsListResponse = (
  openCodeSkills: DiscoveredSkill[] | null,
  workingDirectory: string | undefined,
  launchEnvironment: NodeJS.ProcessEnv | null,
) => buildSkillListResponse(
  mergeDiscoveredSkills(openCodeSkills || [], discoverSkills(workingDirectory)).map((skill) => ({
    ...skill,
    renamable: Boolean(skill.path && skill.path !== '<built-in>' && isManagedSkillPath(skill.path, workingDirectory)),
  })),
  launchEnvironment,
  openCodeSkills === null,
);
