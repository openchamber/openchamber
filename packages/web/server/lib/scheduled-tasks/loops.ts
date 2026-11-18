
import { asNonEmptyString } from '../shared/guards.js';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseMdFile, writeMdFile } from '../opencode/markdown-files.js';
import { getAncestors, findWorktreeRoot } from '../opencode/config-files.js';
import { MAX_TASK_NAME_LENGTH } from '../projects/project-config.js';
import { controlErrorFields } from '../openchamber-control/error.js';
import { isBoolean } from '../shared/object-guards.js';

export interface LoopDefinition {
  name: string;
  enabled: boolean;
  schedule: { kind: 'cron'; cron: string; timezone?: string };
  execution: { prompt: string; providerID: string; modelID: string; agent?: string };
}

export interface LoopFile {
  filePath: string;
  scope: 'user' | 'project';
}

export interface DiscoveredLoop extends LoopFile {
  definition: LoopDefinition | null;
  fingerprint?: string;
}

const isLoopFrontmatter = (value: unknown): value is {
  name?: unknown;
  schedule?: unknown;
  model?: unknown;
  timezone?: unknown;
  agent?: unknown;
  enabled?: unknown;
} => Boolean(value && typeof value === 'object');

const LOOP_DIR_NAME = 'loops';
const USER_LOOP_ROOT = () => path.join(os.homedir(), '.agents', LOOP_DIR_NAME);

const splitProviderModel = (value: string | null) => {
  const raw = value;
  if (!raw) {
    return null;
  }
  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  return {
    providerId: raw.slice(0, separator).trim(),
    modelId: raw.slice(separator + 1).trim(),
  };
};

export const parseLoopDefinition = (filePath: string): LoopDefinition | null => {
  let parsed;
  try {
    parsed = parseMdFile(filePath);
  } catch (error) {
    console.warn(`[loops] skipped malformed loop file ${filePath}:`, controlErrorFields(error)?.message ?? error);
    return null;
  }

  const frontmatter = isLoopFrontmatter(parsed.frontmatter)
    ? parsed.frontmatter
    : {};
  const name = asNonEmptyString(frontmatter.name);
  if (!name) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "name" is required`);
    return null;
  }
  if (name.length > MAX_TASK_NAME_LENGTH) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "name" exceeds ${MAX_TASK_NAME_LENGTH} characters`);
    return null;
  }

  const cron = asNonEmptyString(frontmatter.schedule);
  if (!cron) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "schedule" (cron expression) is required`);
    return null;
  }

  const prompt = asNonEmptyString(parsed.body);
  if (!prompt) {
    console.warn(`[loops] skipped ${filePath}: markdown body (the execution prompt) is required`);
    return null;
  }

  const providerModel = splitProviderModel(asNonEmptyString(frontmatter.model));
  if (!providerModel) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "model" must be "provider/model"`);
    return null;
  }

  const timezone = asNonEmptyString(frontmatter.timezone);
  const agent = asNonEmptyString(frontmatter.agent);
  const schedule: LoopDefinition['schedule'] = { kind: 'cron', cron };
  if (timezone) schedule.timezone = timezone;
  const execution: LoopDefinition['execution'] = {
    prompt,
    providerID: providerModel.providerId,
    modelID: providerModel.modelId,
  };
  if (agent) execution.agent = agent;

  return {
    name,
    enabled: isBoolean(frontmatter.enabled) ? frontmatter.enabled : false,
    schedule,
    execution,
  };
};

export const loopFingerprint = (definition: LoopDefinition) => createHash('sha256')
  .update(JSON.stringify({ name: definition.name, schedule: definition.schedule, execution: definition.execution }))
  .digest('hex');

export const setLoopFileEnabled = (filePath: string, enabled: boolean) => {
  if (!parseLoopDefinition(filePath)) {
    return false;
  }
  const { frontmatter, body } = parseMdFile(filePath);
  writeMdFile(filePath, { ...(frontmatter ?? {}), enabled: Boolean(enabled) }, body);
  return true;
};

const walkLoopMdFiles = (rootDir: string) => {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(rootDir, entry.name))
      .sort();
  } catch {
    return [];
  }
};

export const discoverLoopFiles = (projectPath: string | null | undefined) => {
  const files: LoopFile[] = [];
  for (const filePath of walkLoopMdFiles(USER_LOOP_ROOT())) {
    files.push({ filePath, scope: 'user' });
  }
  if (projectPath) {
    const worktreeRoot = findWorktreeRoot(projectPath) || path.resolve(projectPath);
    for (const ancestor of getAncestors(projectPath, worktreeRoot)) {
      const root = path.join(ancestor, '.agents', LOOP_DIR_NAME);
      for (const filePath of walkLoopMdFiles(root)) {
        files.push({ filePath, scope: 'project' });
      }
    }
  }
  return files;
};

export const discoverLoops = (projectPath: string | null | undefined) => {
  const byName = new Map<string, DiscoveredLoop>();
  const loops: DiscoveredLoop[] = [];
  for (const { filePath, scope } of discoverLoopFiles(projectPath)) {
    const definition = parseLoopDefinition(filePath);
    if (!definition) {
      loops.push({ scope, filePath, definition: null });
      continue;
    }
    const existing = byName.get(definition.name);
    if (existing && (existing.scope === 'project' || scope === 'user')) {
      continue;
    }
    byName.set(definition.name, { scope, filePath, definition, fingerprint: loopFingerprint(definition) });
  }
  for (const entry of byName.values()) {
    loops.push(entry);
  }
  return loops;
};
