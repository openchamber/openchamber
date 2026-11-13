import { z } from 'zod';
import type { Message, Part } from '@/lib/opencode/model';
import { isSkillTool } from '@/lib/opencode/tools';

/** A skill the session has loaded, in the order it first loaded. */
export type LoadedSkill = {
  id: string;
  name: string;
  /** The skill's folder as the skill tool reported it; absent for attached skills. */
  directory?: string;
};

// A field of another shape reads as absent rather than failing the list.
const optionalText = z.string().trim().min(1).optional().catch(undefined);
const skillCallInput = z.object({ id: optionalText }).catch({});
const skillCallMetadata = z.object({ name: optionalText, directory: optionalText }).catch({});

/**
 * Every skill the loaded history shows as loaded: completed skill tool calls,
 * skills attached to a prompt, and skill activations. A pending, running or
 * failed call has not loaded anything yet. Each skill appears once, where it
 * first loaded.
 */
export const selectLoadedSkills = (messages: readonly Message[], parts: Record<string, Part[] | undefined>): LoadedSkill[] => {
  const loaded = new Map<string, LoadedSkill>();
  const add = (skill: LoadedSkill) => {
    if (!loaded.has(skill.id)) loaded.set(skill.id, skill);
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

// A built-in skill lives inside OpenCode (`skill://<id>`, or `<built-in>` once
// the server has marked it): there is no file to open.
const isFilePath = (path: string | undefined): path is string => (
  path !== undefined && path.length > 0 && path !== '<built-in>' && !path.includes('://')
);

/**
 * Where a loaded skill opens: its `SKILL.md` in the app, or its page in
 * Settings > Skills. The installed skill wins, matched by id and then by
 * name, because its path names the file. The folder the skill tool reported
 * covers a skill the list has not read yet. Anything else opens in Settings,
 * which shows a built-in skill read-only.
 */
export const resolveLoadedSkillTarget = (
  skill: LoadedSkill,
  installed: ReadonlyArray<{ id: string; name: string; path: string }>,
): { kind: 'file'; path: string } | { kind: 'settings'; name: string } => {
  const match = installed.find((entry) => entry.id === skill.id) ?? installed.find((entry) => entry.name === skill.name);
  if (match) {
    return isFilePath(match.path) ? { kind: 'file', path: match.path } : { kind: 'settings', name: match.name };
  }
  if (isFilePath(skill.directory)) return { kind: 'file', path: `${skill.directory.replace(/[\\/]+$/, '')}/SKILL.md` };
  return { kind: 'settings', name: skill.name };
};

export const sameLoadedSkills = (left: readonly LoadedSkill[], right: readonly LoadedSkill[]): boolean => (
  left.length === right.length
  && left.every((skill, index) => (
    skill.id === right[index].id && skill.name === right[index].name && skill.directory === right[index].directory
  ))
);
