import fs from 'node:fs/promises';

import { OpenChamberControlError } from '../../openchamber-control/error.js';
import { isString } from '../../shared/guards.js';
import { OPENUI_CONTEXT_GROUPS } from './tools.js';

const GROUPS = OPENUI_CONTEXT_GROUPS;
const MAX_GROUPS = GROUPS.length;
const MAX_CONTENT_LENGTH = 64_000;
const assetUrl = (name) => new URL(name, import.meta.url);
// Fixed contract files are required, so a broken package cannot silently omit them.
const GROUP_FILES = {
  advanced: ['gen.instruction.md'],
  data: ['gen.schema.md', 'gen.instruction.md', 'instruction.md'],
  interaction: ['gen.schema.md', 'gen.instruction.md', 'instruction.md'],
  html: ['gen.schema.md', 'instruction.md'],
  examples: ['instruction.md'],
};

const unavailable = () => {
  throw new OpenChamberControlError('OpenUI instructions are unavailable on this server', 503);
};

const readGroup = async (group) => {
  const files = GROUP_FILES[group];
  const bodies = await Promise.all(files.map((name) => readAsset(`groups/${group}/${name}`)));
  const content = bodies.join('\n\n');
  if (content.length > MAX_CONTENT_LENGTH) unavailable();
  return content;
};

const readAsset = async (name) => {
  try {
    const body = await fs.readFile(assetUrl(name), 'utf8');
    if (!body.trim() || body.length > MAX_CONTENT_LENGTH) unavailable();
    return body;
  } catch {
    return unavailable();
  }
};

export const readOpenUIInstructionGroups = async (groups) => {
  if (!Array.isArray(groups) || groups.length === 0 || !groups.every(isString)) {
    throw new OpenChamberControlError('groups must be a nonempty array of OpenUI instruction group names', 400);
  }
  if (groups.length > MAX_GROUPS) {
    throw new OpenChamberControlError(`groups accepts at most ${MAX_GROUPS} entries`, 400);
  }
  const unique = [...new Set(groups)];
  if (unique.some((group) => !GROUPS.includes(group))) {
    throw new OpenChamberControlError(`groups must use only: ${GROUPS.join(', ')}`, 400);
  }
  const content = (await Promise.all(unique.map(readGroup))).join('\n\n');
  if (content.length > MAX_CONTENT_LENGTH) unavailable();
  return { groups: unique, content };
};

export const readOpenUIGuidance = async () => (
  await Promise.all(['instruction.md', 'gen.instruction.md', 'gen.schema.md'].map(readAsset))
).join('\n\n');
