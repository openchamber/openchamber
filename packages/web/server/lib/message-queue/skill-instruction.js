// The skill instruction a queued message carries, checked again when the
// server delivers it. The template is a JS mirror of
// packages/ui/src/lib/skillMentionInstruction.ts (the composer writes the
// instruction, the server rebuilds it); skill-instruction.test.js runs both
// against the same inputs so the two cannot drift apart.

const INSTRUCTION_PREFIX = 'The user explicitly mentioned these skills in their message: ';
const INSTRUCTION_SUFFIX = ". Use the corresponding skill tool when it is relevant to accomplishing the user's request.";

/** Same as the UI's `buildSkillMentionInstruction`. */
export const buildSkillMentionInstruction = (skillNames) => {
  if (skillNames.length === 0) return null;
  const formatted = skillNames.map((name) => `$${name}`).join(', ');
  return `${INSTRUCTION_PREFIX}${formatted}${INSTRUCTION_SUFFIX}`;
};

/** Same as the UI's `parseSkillMentionInstruction`: the names, or null for text the builder did not write. */
export const parseSkillMentionInstruction = (text) => {
  if (!text.startsWith(INSTRUCTION_PREFIX) || !text.endsWith(INSTRUCTION_SUFFIX)) return null;
  const list = text.slice(INSTRUCTION_PREFIX.length, text.length - INSTRUCTION_SUFFIX.length);
  const tokens = list.split(', ');
  if (tokens.some((token) => token.length < 2 || !token.startsWith('$'))) return null;
  return tokens.map((token) => token.slice(1));
};

/**
 * What the policy lookup has to answer for a queued item's context: the ids
 * of instructions that carry them, and the names in instructions queued
 * before ids existed. Empty lists mean no lookup is needed.
 */
export const queuedSkillReferences = (context) => {
  const ids = new Set();
  const names = new Set();
  for (const part of context) {
    if (part.kind !== 'instruction') continue;
    if (part.skills) {
      for (const skill of part.skills) ids.add(skill.id);
      continue;
    }
    for (const name of parseSkillMentionInstruction(part.text) ?? []) names.add(name);
  }
  return { ids: [...ids], names: [...names] };
};

/**
 * The context with every skill the directory's policy switches off left out
 * of its skill instruction, and an instruction naming none left dropped. Same
 * rules as the UI's `withoutSwitchedOffQueuedSkills`:
 *
 * - `availability.states` maps a skill id to `enabled` or `disabled`; an id
 *   it does not hold is unknown and stays named. Only a known `disabled`
 *   removes a skill.
 * - An instruction with `skills` is checked by id, so another skill with the
 *   same display name is never affected.
 * - An instruction without `skills` (queued before they existed) is checked
 *   by the names in its text, and only when the text is exactly what the
 *   builder writes. A name stays while any installed skill with that name or
 *   id is not switched off, and when `availability.inventory` is null (the
 *   installed skills could not be listed completely).
 *
 * Other parts, and the message itself, are never changed.
 */
export const withoutSwitchedOffSkills = (context, availability) => {
  const isOff = (id) => availability.states.get(id) === 'disabled';
  const nameIsOff = (name) => {
    const candidates = availability.inventory?.filter((skill) => skill.name === name || skill.id === name) ?? [];
    return candidates.length > 0 && candidates.every((skill) => isOff(skill.id));
  };

  const revised = [];
  for (const part of context) {
    if (part.kind !== 'instruction') {
      revised.push(part);
      continue;
    }
    if (part.skills) {
      const kept = part.skills.filter((skill) => !isOff(skill.id));
      if (kept.length === part.skills.length) revised.push(part);
      else if (kept.length > 0) {
        revised.push({ kind: 'instruction', text: buildSkillMentionInstruction(kept.map((skill) => skill.name)), skills: kept });
      }
      continue;
    }
    const names = availability.inventory ? parseSkillMentionInstruction(part.text) : null;
    if (!names) {
      revised.push(part);
      continue;
    }
    const kept = names.filter((name) => !nameIsOff(name));
    if (kept.length === names.length) revised.push(part);
    else if (kept.length > 0) revised.push({ kind: 'instruction', text: buildSkillMentionInstruction(kept) });
  }
  return revised;
};
