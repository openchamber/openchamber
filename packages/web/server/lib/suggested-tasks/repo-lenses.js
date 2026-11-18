// Lenses the team keeps in the repository: `.agents/lenses/*.md`.
//
//   ---
//   name: Security review
//   model: anthropic/claude-sonnet-4-5
//   variant: high
//   agent: plan
//   web: false
//   action: suggest
//   ---
//   Look for injection, missing authorization checks and secrets in logs.
//
// A repository lens arrives with a pull, so it runs only after the user
// enabled this exact version on this machine: the approval records a
// fingerprint of everything that decides what the lens does, and a change to
// any of it waits for a new approval. The same rule as repository loops
// (`scheduled-tasks/loops.js`).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseMdFileAsync } from '../opencode/shared.js';
import { LENS_ACTIONS, MAX_LENS_NAME_LENGTH, MAX_LENS_PROMPT_LENGTH, lensMcpSchema, lensPermissionModeSchema } from './config.js';

const REPO_LENS_DIRECTORY = path.join('.agents', 'lenses');

const frontmatterSchema = z.object({
  name: z.string().trim().min(1).max(MAX_LENS_NAME_LENGTH),
  model: z.string().trim().regex(/^[^/\s]+\/\S+$/).optional(),
  variant: z.string().trim().min(1).max(100).optional(),
  agent: z.string().trim().min(1).max(200).optional(),
  web: z.boolean().default(false),
  action: z.enum(LENS_ACTIONS).default('suggest'),
  mcp: lensMcpSchema,
  permissionMode: lensPermissionModeSchema,
});

const bodySchema = z.string().trim().min(1).max(MAX_LENS_PROMPT_LENGTH);

const errorCodeSchema = z.object({ code: z.string() });

/** What an approval covers: the whole definition, so any change needs a new one. */
const fingerprintOf = (lens) => {
  const definition = { name: lens.name, prompt: lens.prompt, model: lens.model, web: lens.web, action: lens.action };
  if (lens.mcp.length) definition.mcp = lens.mcp;
  if (lens.permissionMode !== 'default') definition.permissionMode = lens.permissionMode;
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
};

const lensFromFile = async (filePath) => {
  let parsed;
  try {
    parsed = await parseMdFileAsync(filePath);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const frontmatter = frontmatterSchema.safeParse(parsed.frontmatter);
  if (!frontmatter.success) {
    const issue = frontmatter.error.issues[0];
    return { ok: false, error: `${issue.path.join('.') || 'frontmatter'}: ${issue.message}` };
  }
  const prompt = bodySchema.safeParse(parsed.body);
  if (!prompt.success) return { ok: false, error: 'the file needs the lens prompt as its body' };
  const { name, model, variant, agent, web, action, mcp, permissionMode } = frontmatter.data;
  const separator = model ? model.indexOf('/') : -1;
  const lensModel = model
    ? { useDefaults: false, providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
    : { useDefaults: true };
  if (variant) lensModel.variant = variant;
  if (agent) lensModel.agent = agent;
  return { ok: true, lens: { name, prompt: prompt.data, model: lensModel, web, action, mcp, permissionMode } };
};

/**
 * The repository lenses of a checkout, each with its approval state on this
 * machine. A file that cannot be read is listed with its error, so the user
 * sees why it does not run instead of it silently disappearing.
 */
export const listRepositoryLenses = async (projectPath, approvals) => {
  const directory = path.join(projectPath, REPO_LENS_DIRECTORY);
  let names;
  try {
    names = (await fs.promises.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (errorCodeSchema.safeParse(error).data?.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => {
    const filePath = path.join(directory, name);
    const id = `repo:${name.slice(0, -3)}`;
    const result = await lensFromFile(filePath);
    if (!result.ok) return { id, file: filePath, status: 'invalid', error: result.error };
    const fingerprint = fingerprintOf(result.lens);
    const approved = approvals[filePath];
    const status = approved === fingerprint ? 'enabled' : (approved ? 'changed' : 'disabled');
    return { id, file: filePath, status, fingerprint, ...result.lens };
  }));
};
