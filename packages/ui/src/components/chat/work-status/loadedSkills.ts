import { z } from 'zod';
import type { Message, Part } from '@/lib/opencode/model';
import { isSkillTool } from '@/lib/opencode/tools';

export type LoadedSkill = {
  id: string;
  name: string;
  directory?: string;
};

const optionalText = z.string().trim().min(1).optional().catch(undefined);
const skillCallInput = z.object({ id: optionalText }).catch({});
const skillCallMetadata = z.object({ name: optionalText, directory: optionalText }).catch({});

export const selectLoadedSkills = (messages: readonly Message[], parts: Record<string, Part[] | undefined>): LoadedSkill[] => {
  const loaded = new Map<string, LoadedSkill>();
  const add = (skill: LoadedSkill) => {
    const first = loaded.get(skill.id);
    if (!first) {
      loaded.set(skill.id, skill);
      return;
    }
    loaded.set(skill.id, {
      id: skill.id,
      name: first.name === first.id ? skill.name : first.name,
      directory: first.directory ?? skill.directory,
    });
  };
  for (const message of messages) {
    if (message.role === 'user') {
      message.skills?.forEach((skill) => add({ id: skill.id, name: skill.name }));
    } else if (message.role === 'skill') {
      add({ id: message.skill, name: message.name });
    } else if (message.role === 'assistant') {
      for (const part of parts[message.id] ?? []) {
        if (part.type !== 'tool' || !isSkillTool(part.tool) || part.state.status !== 'completed') continue;
        const { id } = skillCallInput.parse(part.state.input);
        if (!id) continue;
        const { name, directory } = skillCallMetadata.parse(part.state.metadata ?? {});
        add({ id, name: name ?? id, directory });
      }
    }
  }
  return [...loaded.values()];
};

export const isSkillFilePath = (path: string | undefined): path is string => (
  path !== undefined && path.length > 0 && path !== '<built-in>' && !path.includes('://')
);

export const resolveLoadedSkillTarget = (
  skill: LoadedSkill,
  installed: ReadonlyArray<{ id: string; name: string; path: string }>,
): { kind: 'file'; path: string } | { kind: 'settings'; name: string } => {
  const match = installed.find((entry) => entry.id === skill.id) ?? installed.find((entry) => entry.name === skill.name);
  if (match) {
    return isSkillFilePath(match.path) ? { kind: 'file', path: match.path } : { kind: 'settings', name: match.name };
  }
  if (isSkillFilePath(skill.directory)) return { kind: 'file', path: `${skill.directory.replace(/[\\/]+$/, '')}/SKILL.md` };
  return { kind: 'settings', name: skill.name };
};

export const sameLoadedSkills = (left: readonly LoadedSkill[], right: readonly LoadedSkill[]): boolean => (
  left.length === right.length
  && left.every((skill, index) => (
    skill.id === right[index].id && skill.name === right[index].name && skill.directory === right[index].directory
  ))
);
