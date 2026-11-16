import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GUEST_BLOCK_RESERVED_NAMES, isGuestApproved, parseOpenChamberVersion, requestedGuestCapabilities } from '@openchamber/sdk';

import { resolveOpenCodePluginFolder } from './opencode-plugin.js';


const AUTHORING_SKILL_NAME = 'openchamber-extensions';
const AUTHORING_SKILL_SOURCE = fileURLToPath(new URL('./authoring/skill.txt', import.meta.url));

export const EXTENSION_AUTHORING_COMMAND = 'new-extension';

const isActive = (guest) => guest.enabled !== false
  && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants ?? [] });

const blockSignature = (block) => `${block.name}(${block.args.map((arg) => `${arg}: string`).join(', ')})`;

/**
 * Signatures an agent reads; the catalog's own go in `UI_BLOCKS_GUIDANCE`.
 * @param {object[]} guests active catalog rows
 */
export const describeExtensionBlocks = (guests) => {
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
 *   fsPromises?: Pick<typeof import('node:fs/promises'), 'realpath' | 'stat' | 'readFile'>,
 * }} deps
 */
export const createGuestAgentContext = ({ listGuests, instructions, fsPromises = fs }) => {
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

  const skillDirectories = async () => {
    const guests = await listGuests().catch(() => []);
    return guests
      .filter((guest) => isActive(guest) && guest.skills && guest.capabilityGrants?.includes('skills'))
      .map((guest) => path.resolve(guest.packageRoot, guest.skills));
  };

  const pluginDirectories = async () => {
    const guests = await listGuests().catch(() => []);
    const directories = [];
    for (const guest of guests) {
      if (!isActive(guest) || !guest.opencodePlugin || !guest.capabilityGrants?.includes('opencodePlugin')) continue;
      const directory = await resolveOpenCodePluginFolder(fsPromises, guest.packageRoot, guest.opencodePlugin);
      if (directory) directories.push(directory);
    }
    return directories;
  };

  return { instructionText, skillDirectories, pluginDirectories };
};

const pinAuthoringSkill = (template, openchamberVersion) => {
  const core = parseOpenChamberVersion(openchamberVersion);
  return template
    .replaceAll('{{sdkVersion}}', core ? openchamberVersion : 'latest')
    .replaceAll('{{engineFloor}}', core ? `${core.major}.${core.minor}.${core.patch}` : '0.0.0');
};

/**
 * The extension-writing skill as a file OpenCode can scan, under the instance
 * directory: the packaged source may sit inside an archive OpenCode cannot read.
 * @returns {Promise<{ skillsRoot: string, command: { description: string, template: string } }>}
 */
export const materializeAuthoringSkill = async ({ fsPromises, instanceDir, openchamberVersion }) => {
  const skillsRoot = path.join(instanceDir, 'skills');
  const directory = path.join(skillsRoot, AUTHORING_SKILL_NAME);
  const target = path.join(directory, 'SKILL.md');
  await fsPromises.mkdir(directory, { recursive: true });
  const template = await fsPromises.readFile(AUTHORING_SKILL_SOURCE, 'utf8');
  await fsPromises.writeFile(target, pinAuthoringSkill(template, openchamberVersion), 'utf8');
  return {
    skillsRoot,
    command: {
      description: 'Build an OpenChamber extension',
      template: `Read ${target} and follow it to build this extension:\n\n$ARGUMENTS`,
    },
  };
};
