import { OpenCode } from '@opencode/client';
import type { ListedSkill } from './skills.js';

type OpenCodeClient = ReturnType<typeof OpenCode.make>;

export const createSkillClientFactory = (
  getOpenCodeAuthHeaders: () => Record<string, string>,
  buildOpenCodeUrl: (path: string, prefix: string) => string,
) => (workingDirectory: string | null): OpenCodeClient => {
  const headers = { ...getOpenCodeAuthHeaders() };
  if (workingDirectory) headers['x-opencode-directory'] = encodeURIComponent(workingDirectory);
  return OpenCode.make({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }),
  });
};

export const withSkillBody = async (skill: ListedSkill | null, client: OpenCodeClient): Promise<ListedSkill | null> => {
  if (!skill || skill.path !== '<built-in>' || skill.content) return skill;
  try {
    const body = await client.experimental.skill.file({ skillID: skill.id ?? skill.name, path: 'SKILL.md' });
    return { ...skill, content: new TextDecoder().decode(body) };
  } catch (error) {
    console.error(`Failed to load skill ${skill.name}:`, error);
    return skill;
  }
};
