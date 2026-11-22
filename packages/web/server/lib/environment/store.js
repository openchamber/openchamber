import fs from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { z } from 'zod';

import {
  MAX_COMMAND_LENGTH,
  MAX_VARIABLES,
  MAX_VARIABLE_VALUE_LENGTH,
  isVariableName,
} from './variables.js';

/**
 * Environment variables the user typed in Settings, for everything
 * OpenChamber starts, plus each project's environment command. Values can be
 * API tokens, so they live in one file of their own, mode 0600, and never
 * leave the server: the routes answer variable names, never values.
 *
 * {
 *   "version": 1,
 *   "user": { "variables": { "NAME": "value" } },
 *   "projects": { "<projectId>": { "variables": { ... }, "command": "direnv export json" } }
 * }
 *
 * A file that exists but cannot be read or parsed is an error, never an
 * empty store: a write on top of it would erase every stored secret.
 */

const variableName = z.string().refine(isVariableName);
const variableValue = z.string().max(MAX_VARIABLE_VALUE_LENGTH);
const variablesSchema = z.record(variableName, variableValue)
  .refine((variables) => Object.keys(variables).length <= MAX_VARIABLES);
const commandSchema = z.string().trim().min(1).max(MAX_COMMAND_LENGTH);

// Project ids are path-derived (`path_<base64url>`, `path_sha256_<hex>`).
// The pattern also keeps `__proto__` out of the projects record.
const PROJECT_ID_PATTERN = /^(?!__proto__$)[A-Za-z0-9_-]{1,512}$/;
export const isProjectId = (value) => PROJECT_ID_PATTERN.test(value);

const projectEntrySchema = z.object({
  variables: variablesSchema.optional(),
  command: commandSchema.optional(),
});

/**
 * Read cap for environment.json. The write side clamps each entry:
 * MAX_VARIABLES is 200 variables, each value at most
 * MAX_VARIABLE_VALUE_LENGTH (32,000) characters, plus a command of at most
 * MAX_COMMAND_LENGTH (4,000) characters, so one user or project entry
 * serializes to roughly 6.5 MB at worst. The number of project entries has
 * no bound, so no small maximum covers every legitimate file. 64 MiB is
 * about ten worst-case entries: roomy for real files, and one oversized
 * file cannot be buffered whole on this synchronous polling path.
 */
export const MAX_ENVIRONMENT_FILE_BYTES = 64 * 1024 * 1024;

const storeSchema = z.object({
  version: z.literal(1),
  user: z.object({ variables: variablesSchema.optional() }).optional(),
  projects: z.record(z.string().refine(isProjectId), projectEntrySchema).optional(),
});

// A string sets a variable, null removes it, a name left out stays as is.
const variablesPatchSchema = z.record(variableName, z.union([variableValue, z.null()]));
const userPatchSchema = z.object({ variables: variablesPatchSchema.optional() }).strict();
const projectPatchSchema = z.object({
  variables: variablesPatchSchema.optional(),
  // An empty string or null removes the command.
  command: z.union([z.literal(''), z.null(), commandSchema]).optional(),
}).strict();

export class EnvironmentStoreError extends Error {}

/** The patch was malformed; nothing was written. */
export class EnvironmentPatchError extends Error {}

const parsePatch = (schema, body) => {
  const result = schema.safeParse(body);
  if (!result.success) throw new EnvironmentPatchError('Invalid environment update');
  return result.data;
};

const applyVariablesPatch = (current, patch) => {
  const next = { ...current };
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  if (Object.keys(next).length > MAX_VARIABLES) throw new EnvironmentPatchError(`At most ${MAX_VARIABLES} variables`);
  return next;
};

const describeVariables = (variables) => Object.keys(variables ?? {}).sort();

export const createEnvironmentStore = ({ filePath }) => {
  // One in-process writer at a time: two saves from Settings must not read
  // the same old file and drop each other's change.
  let writeQueue = Promise.resolve();
  // Git reads the environment on every command, polling included, so the
  // parsed document is kept in memory. This module is the file's only
  // writer; a failed read is not kept and is retried on the next call.
  let cached = null;

  const read = () => {
    if (cached) return cached;
    cached = readFromDisk();
    return cached;
  };

  const readFromDisk = () => {
    // The shared bounded reader (../shared/bounded-file-read.js) judges the
    // opened handle, so a FIFO at the path is refused instead of blocking
    // this synchronous read, and a file over the cap is refused after at
    // most cap + 1 bytes. Missing is its own answer; every other refusal
    // and every unexpected I/O error takes the unreadable path below, so a
    // file that exists still never reads as an empty store.
    let result;
    try {
      result = readBoundedFileSync(filePath, MAX_ENVIRONMENT_FILE_BYTES);
    } catch (error) {
      throw new EnvironmentStoreError(`environment.json is unreadable: ${error?.code ?? 'error'}`);
    }
    if (!result.ok) {
      if (result.reason === 'missing') return { version: 1 };
      throw new EnvironmentStoreError(`environment.json is unreadable: ${result.code}`);
    }
    let parsed;
    try {
      parsed = storeSchema.safeParse(JSON.parse(result.buffer.toString('utf8')));
    } catch {
      throw new EnvironmentStoreError('environment.json is not valid JSON');
    }
    if (!parsed.success) throw new EnvironmentStoreError('environment.json does not match the expected shape');
    return parsed.data;
  };

  const write = (document) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // rename keeps the temporary file's mode, so an older, wider file is
    // replaced by a 0600 one.
    renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporaryPath, filePath);
    cached = document;
  };

  const mutate = (change) => {
    const run = writeQueue.then(() => {
      const next = change(read());
      write(next);
      return next;
    });
    writeQueue = run.catch(() => undefined);
    return run;
  };

  const userVariables = () => ({ ...(read().user?.variables ?? {}) });

  const storedProject = (document, projectId) => (
    document.projects && Object.hasOwn(document.projects, projectId) ? document.projects[projectId] : undefined
  );

  const projectEntry = (projectId) => {
    const entry = storedProject(read(), projectId);
    return {
      variables: { ...(entry?.variables ?? {}) },
      command: entry?.command ?? null,
    };
  };

  const hasProjectEntries = () => Object.keys(read().projects ?? {}).length > 0;

  const describeUser = () => ({ names: describeVariables(read().user?.variables) });

  const describeProject = (projectId) => {
    const entry = storedProject(read(), projectId);
    return { names: describeVariables(entry?.variables), command: entry?.command ?? null };
  };

  const updateUser = async (body) => {
    const patch = parsePatch(userPatchSchema, body);
    const next = await mutate((document) => {
      const variables = applyVariablesPatch(document.user?.variables, patch.variables);
      const { user: _user, ...rest } = document;
      return Object.keys(variables).length > 0 ? { ...rest, user: { variables } } : rest;
    });
    return { names: describeVariables(next.user?.variables) };
  };

  const updateProject = async (projectId, body) => {
    if (!isProjectId(projectId)) throw new EnvironmentPatchError('Invalid project id');
    const patch = parsePatch(projectPatchSchema, body);
    const next = await mutate((document) => {
      const current = storedProject(document, projectId) ?? {};
      const variables = applyVariablesPatch(current.variables, patch.variables);
      const command = patch.command === undefined ? current.command : (patch.command || undefined);
      const entry = {};
      if (Object.keys(variables).length > 0) entry.variables = variables;
      if (command) entry.command = command;
      const projects = { ...(document.projects ?? {}) };
      if (Object.keys(entry).length > 0) projects[projectId] = entry;
      else delete projects[projectId];
      const { projects: _projects, ...rest } = document;
      return Object.keys(projects).length > 0 ? { ...rest, projects } : rest;
    });
    const entry = storedProject(next, projectId);
    return { names: describeVariables(entry?.variables), command: entry?.command ?? null };
  };

  return { userVariables, projectEntry, hasProjectEntries, describeUser, describeProject, updateUser, updateProject };
};
