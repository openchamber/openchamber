import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GUEST_BLOCK_RESERVED_NAMES, isGuestApproved, parseOpenChamberVersion, requestedGuestCapabilities } from '@openchamber/sdk';

import { resolveOpenCodePluginFolder } from './opencode-plugin.js';
import type { GuestBlockContribution } from '@openchamber/sdk';
import type { GuestRecord } from './contracts.js';


const AUTHORING_SKILL_NAME = 'openchamber-extensions';
const AUTHORING_SKILL_SOURCE = fileURLToPath(new URL('./authoring/skill.txt', import.meta.url));

export const EXTENSION_AUTHORING_COMMAND = 'new-extension';

const isActive = (guest: GuestRecord) => guest.enabled !== false
  && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants ?? [] });

const blockSignature = (block: GuestBlockContribution) => `${block.name}(${block.args.map((arg) => `${arg}: string`).join(', ')})`;

export const describeExtensionBlocks = (guests: GuestRecord[]) => {
  const blocks = new Map<string, GuestBlockContribution>();
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

type AgentContextOptions = {
  listGuests: () => Promise<GuestRecord[]>;
  instructions: { forDirectory: (directory: string | null, guestIds: Set<string>) => Promise<Array<{ guestId: string; text: string }>> };
  fsPromises?: Pick<typeof fs, 'realpath' | 'stat' | 'readFile'>;
};

export const createGuestAgentContext = ({ listGuests, instructions, fsPromises = fs }: AgentContextOptions) => {
  const instructionText = async (directory: string | null) => {
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
    const guests = await listGuests().catch((): GuestRecord[] => []);
    return guests
      .filter((guest): guest is GuestRecord & { skills: string } => !!(isActive(guest) && guest.skills && guest.capabilityGrants?.includes('skills')))
      .map((guest) => path.resolve(guest.packageRoot, guest.skills));
  };

  const pluginDirectories = async () => {
    const guests = await listGuests().catch((): GuestRecord[] => []);
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

const pinAuthoringSkill = (template: string, openchamberVersion = '') => {
  const core = parseOpenChamberVersion(openchamberVersion);
  return template
    .replaceAll('{{sdkVersion}}', core ? openchamberVersion : 'latest')
    .replaceAll('{{engineFloor}}', core ? `${core.major}.${core.minor}.${core.patch}` : '0.0.0');
};

export const materializeAuthoringSkill = async ({ fsPromises, instanceDir, openchamberVersion }: { fsPromises: typeof fs; instanceDir: string; openchamberVersion?: string | undefined }) => {
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
