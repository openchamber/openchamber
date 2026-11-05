import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GUEST_BLOCK_RESERVED_NAMES, isGuestApproved, requestedGuestCapabilities } from '@openchamber/sdk';

/**
 * What extensions add to agents: the text and block components a session is
 * told about, and the skill folders OpenCode loads. Only an active extension
 * counts, read from the catalog at each use, so a pause takes it all away.
 */

const AUTHORING_SKILL_NAME = 'openchamber-extensions';
// Not `.md`: the desktop build strips Markdown from `node_modules`, and OpenCode would start without its config.
const AUTHORING_SKILL_SOURCE = fileURLToPath(new URL('./authoring/skill.txt', import.meta.url));

/** The command that starts extension work; the skill itself stays out of the agent's own reach. */
export const EXTENSION_AUTHORING_COMMAND = 'new-extension';

const isActive = (guest) => guest.enabled !== false
  && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants ?? [] });

const blockSignature = (block) => `${block.name}(${block.args.map((arg) => `${arg}: string`).join(', ')})`;

/**
 * Signatures an agent reads; the catalog's own go in `UI_BLOCKS_GUIDANCE`.
 * @param {object[]} guests active catalog rows
 */
export const describeExtensionBlocks = (guests) => {
  // What the chat draws: the catalog keeps its names and the first extension keeps a shared one.
  const blocks = new Map();
  for (const block of guests.flatMap((guest) => guest.blocks ?? [])) {
    if (!GUEST_BLOCK_RESERVED_NAMES.includes(block.name) && !blocks.has(block.name)) blocks.set(block.name, block);
  }
  const lines = [...blocks.values()].map((block) => `${blockSignature(block)}: ${block.description}`);
  if (lines.length === 0) return '';
  const asking = [...blocks.values()].filter((block) => block.answers).map((block) => block.name);
  return [
    'More UI block components, from the user\'s extensions. An Item like any other, each draws itself:',
    ...lines,
    ...(asking.length > 0
      ? [`To ask the user, when its description fits, use ${asking.join(' or ')} in a reply block: it takes the answer itself, in place of Choice, the question tool or a page with awaitAnswer.`]
      : []),
  ].join('\n');
};

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   instructions: { forDirectory: (directory: string | null, guestIds: Set<string>) => Promise<Array<{ guestId: string, text: string }>> },
 * }} deps
 */
export const createGuestAgentContext = ({ listGuests, instructions }) => {
  /** The session's extension entry, or `null` when the catalog cannot be read, which keeps what it holds. */
  const instructionText = async (directory) => {
    let guests;
    try {
      guests = (await listGuests()).filter(isActive);
    } catch {
      return null;
    }
    const allowed = new Set(guests.filter((guest) => guest.capabilityGrants?.includes('instructions')).map((guest) => guest.id));
    const texts = await instructions.forDirectory(directory, allowed).catch(() => null);
    if (texts === null) return null;
    const nameOf = new Map(guests.map((guest) => [guest.id, guest.name]));
    return [
      describeExtensionBlocks(guests),
      ...texts.map(({ guestId, text }) => `From the extension ${nameOf.get(guestId) ?? guestId}:\n${text}`),
    ].filter(Boolean).join('\n\n');
  };

  /** Package folders of the skills active extensions ship. A catalog that cannot be read gives none. */
  const skillDirectories = async () => {
    const guests = await listGuests().catch(() => []);
    return guests
      .filter((guest) => isActive(guest) && guest.skills && guest.capabilityGrants?.includes('skills'))
      .map((guest) => path.resolve(guest.packageRoot, guest.skills));
  };

  return { instructionText, skillDirectories };
};

/**
 * The extension-writing skill as a file OpenCode can scan, under the instance
 * directory: the packaged source may sit inside an archive OpenCode cannot read.
 * @returns {Promise<{ skillsRoot: string, command: { description: string, template: string } }>}
 */
export const materializeAuthoringSkill = async ({ fsPromises, instanceDir }) => {
  const skillsRoot = path.join(instanceDir, 'skills');
  const directory = path.join(skillsRoot, AUTHORING_SKILL_NAME);
  const target = path.join(directory, 'SKILL.md');
  await fsPromises.mkdir(directory, { recursive: true });
  await fsPromises.writeFile(target, await fsPromises.readFile(AUTHORING_SKILL_SOURCE, 'utf8'), 'utf8');
  return {
    skillsRoot,
    command: {
      description: 'Build an OpenChamber extension',
      template: `Read ${target} and follow it to build this extension:\n\n$ARGUMENTS`,
    },
  };
};
