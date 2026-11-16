import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  MAX_COMMAND_LENGTH,
  MAX_VARIABLES,
  MAX_VARIABLE_VALUE_LENGTH,
  isVariableName,
} from './variables.js';

const variableName = z.string().refine(isVariableName);
const variableValue = z.string().max(MAX_VARIABLE_VALUE_LENGTH);
const variablesSchema = z.record(variableName, variableValue)
  .refine((variables) => Object.keys(variables).length <= MAX_VARIABLES);
const commandSchema = z.string().trim().min(1).max(MAX_COMMAND_LENGTH);

const PROJECT_ID_PATTERN = /^(?!__proto__$)[A-Za-z0-9_-]{1,512}$/;
export const isProjectId = (value) => PROJECT_ID_PATTERN.test(value);

const projectEntrySchema = z.object({
  variables: variablesSchema.optional(),
  command: commandSchema.optional(),
});

const storeSchema = z.object({
  version: z.literal(1),
  user: z.object({ variables: variablesSchema.optional() }).optional(),
  projects: z.record(z.string().refine(isProjectId), projectEntrySchema).optional(),
});

const variablesPatchSchema = z.record(variableName, z.union([variableValue, z.null()]));
const userPatchSchema = z.object({ variables: variablesPatchSchema.optional() }).strict();
const projectPatchSchema = z.object({
  variables: variablesPatchSchema.optional(),
  command: z.union([z.literal(''), z.null(), commandSchema]).optional(),
}).strict();

export class EnvironmentStoreError extends Error {}

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
  let writeQueue = Promise.resolve();
  let cached = null;

  const read = () => {
    if (cached) return cached;
    cached = readFromDisk();
    return cached;
  };

  const readFromDisk = () => {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1 };
      throw new EnvironmentStoreError(`environment.json is unreadable: ${error?.code ?? 'error'}`);
    }
    let parsed;
    try {
      parsed = storeSchema.safeParse(JSON.parse(raw));
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
    fs.renameSync(temporaryPath, filePath);
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
