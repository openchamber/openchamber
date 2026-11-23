import { z } from 'zod';
import { asNonEmptyString, isRecord, isString } from '../shared/object-guards.js';
import { createMessageId } from '../dispatch-results/runtime.js';
import { LOCATION_PLUGINS_NOT_READY, waitForPluginList } from '../opencode/location-plugins.js';

interface FetchOptions {
  directory?: string | undefined;
  method?: string;
  body?: object;
  query?: Record<string, string>;
}

interface ResolvedSkills {
  attached: { id: string; name: string }[];
  unresolved: string[];
}

export interface SkillInstruction {
  id: string;
  names: string[];
}

interface SkillCarrier {
  skills?: string[];
  skillInstructions?: SkillInstruction[];
}

interface PromptBody {
  text: string;
  files?: { uri: string; name?: string }[];
  agents?: { name: string }[];
  skills?: { id: string }[];
}

export const catalogScope = (directory: string | undefined) => ({ directory, query: directory ? { 'location[directory]': directory } : {} });

export const awaitCatalog = async <Result>(
  openCodeFetch: (fetchPath: string, options?: FetchOptions) => Promise<Result>,
  directory: string | undefined,
) => {
  const ready = await waitForPluginList(async () => {
    const plugins = await openCodeFetch('/api/plugin', catalogScope(directory));
    return Array.isArray(plugins) ? plugins : [];
  });
  if (!ready) throw new Error(LOCATION_PLUGINS_NOT_READY);
};

export const parseQueuedSkills = z.unknown().transform((value): string[] => [
  ...new Set((Array.isArray(value) ? value : []).map((entry) => asNonEmptyString(entry) ?? '').filter(Boolean)),
]).parse;

export const parseSkillInstructions = z.unknown().transform((value): SkillInstruction[] => (Array.isArray(value) ? value : []).flatMap((entry) => {
  if (!isRecord(entry) || !isString(entry.id) || !Array.isArray(entry.names)) return [];
  const names: string[] = entry.names.filter(isString);
  return names.length > 0 ? [{ id: entry.id, names }] : [];
})).parse;

const parseKnownSkills = z.unknown().transform((value) => (Array.isArray(value) ? value : []).flatMap((entry) => (
  isRecord(entry) ? [{ id: asNonEmptyString(entry.id), name: isString(entry.name) ? entry.name : null }] : []
))).parse;

const isSkillNotFound = z.unknown().transform((error) => (
  isRecord(error) && error.status === 400 && isString(error.message) && error.message.includes('Skill not found')
)).parse;

const skillMentionInstruction = (names: readonly string[]) =>
  `The user explicitly mentioned these skills in their message: ${names.map((name) => `$${name}`).join(', ')}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;

export function createQueuedSkills<Result>({ openCodeFetch, persist, now }: {
  openCodeFetch: (fetchPath: string, options?: FetchOptions) => Promise<Result>;
  persist: () => Promise<void>;
  now: () => number;
}) {
  const resolve = async (names: readonly string[], directory: string | undefined): Promise<ResolvedSkills> => {
    if (names.length === 0) return { attached: [], unresolved: [] };
    let known: ReturnType<typeof parseKnownSkills>;
    try {
      await awaitCatalog(openCodeFetch, directory);
      known = parseKnownSkills(await openCodeFetch('/api/skill', catalogScope(directory)));
    } catch (error) {
      console.warn('[message-queue] could not list skills; naming them in an instruction instead:', (isRecord(error) ? error.message : undefined) ?? error);
      return { attached: [], unresolved: [...names] };
    }
    const resolved: ResolvedSkills = { attached: [], unresolved: [] };
    for (const name of names) {
      const id = (known.find((skill) => skill.name === name) ?? known.find((skill) => skill.id === name))?.id;
      if (!id) resolved.unresolved.push(name);
      else if (!resolved.attached.some((skill) => skill.id === id)) resolved.attached.push({ id, name });
    }
    return resolved;
  };

  const instructionsFor = async (item: SkillCarrier, names: readonly string[]) => {
    const previous = item.skillInstructions;
    const uncovered = names.filter((name) => !previous?.some((instruction) => instruction.names.includes(name)));
    if (uncovered.length > 0) {
      item.skillInstructions = [...(previous ?? []), { id: createMessageId(now()), names: uncovered }];
      try {
        await persist();
      } catch (error) {
        if (previous) item.skillInstructions = previous;
        else delete item.skillInstructions;
        throw error;
      }
    }
    return (item.skillInstructions ?? []).filter((instruction) => instruction.names.some((name) => names.includes(name)));
  };

  const prepare = async (sessionId: string, directory: string, item: SkillCarrier, isCommand: boolean, commitRevert: () => Promise<void>) => {
    const skills: ResolvedSkills = isCommand
      ? { attached: [], unresolved: item.skills ?? [] }
      : await resolve(item.skills ?? [], directory);
    let reverted: Promise<void> | null = null;
    const commitStagedRevert = () => (reverted ??= commitRevert());
    const admitInstructions = async (names: readonly string[]) => {
      const instructions = await instructionsFor(item, names);
      await commitStagedRevert();
      for (const { id, names: covered } of instructions) {
        await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
          directory,
          method: 'POST',
          body: { id, text: skillMentionInstruction(covered), resume: false },
        });
      }
    };
    const prompt = (body: PromptBody) => openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      directory,
      method: 'POST',
      body,
    });

    return {
      commitStagedRevert,
      admitUnresolved: async () => {
        if (skills.unresolved.length > 0) await admitInstructions(skills.unresolved);
      },
      sendPrompt: async (text: string, files: NonNullable<PromptBody['files']>, agentMention: string | undefined) => {
        const body: PromptBody = { text };
        if (files.length > 0) body.files = files;
        if (agentMention) body.agents = [{ name: agentMention }];
        if (skills.attached.length === 0) {
          await prompt(body);
          return;
        }
        try {
          await prompt({ ...body, skills: skills.attached.map((skill) => ({ id: skill.id })) });
        } catch (error) {
          if (!isSkillNotFound(error)) throw error;
          await admitInstructions(skills.attached.map((skill) => skill.name));
          await prompt(body);
        }
      },
    };
  };

  return { prepare };
}
