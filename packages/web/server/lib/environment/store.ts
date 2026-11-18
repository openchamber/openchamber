import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  MAX_COMMAND_LENGTH,
  MAX_VARIABLES,
  MAX_VARIABLE_VALUE_LENGTH,
  isVariableName,
} from './variables.js';
import type { EnvironmentVariables } from './variables.js';

const variableName = z.string().refine(isVariableName);
const variableValue = z.string().max(MAX_VARIABLE_VALUE_LENGTH);
const variablesSchema = z.record(variableName, variableValue)
  .refine((variables) => Object.keys(variables).length <= MAX_VARIABLES);
const commandSchema = z.string().trim().min(1).max(MAX_COMMAND_LENGTH);

const PROJECT_ID_PATTERN = /^(?!__proto__$)[A-Za-z0-9_-]{1,512}$/;
export const isProjectId = (value: string) => PROJECT_ID_PATTERN.test(value);

const projectEntrySchema = z.object({
  variables: variablesSchema.optional(),
  command: commandSchema.optional(),
});

const storeSchema = z.object({
  version: z.literal(1),
  user: z.object({ variables: variablesSchema.optional() }).optional(),
  projects: z.record(z.string().refine(isProjectId), projectEntrySchema).optional(),
});
type EnvironmentDocument = z.infer<typeof storeSchema>;
type StoredProject = z.infer<typeof projectEntrySchema>;

const variablesPatchSchema = z.record(variableName, z.union([variableValue, z.null()]));
const userPatchSchema = z.object({ variables: variablesPatchSchema.optional() }).strict();
const projectPatchSchema = z.object({
  variables: variablesPatchSchema.optional(),
  command: z.union([z.literal(''), z.null(), commandSchema]).optional(),
}).strict();

export class EnvironmentStoreError extends Error {}

export class EnvironmentPatchError extends Error {}

const parsePatch = <T extends z.ZodType>(schema: T) => z.unknown().transform((body): z.output<T> => {
  const result = schema.safeParse(body);
  if (!result.success) throw new EnvironmentPatchError('Invalid environment update');
  return result.data;
}).parse;

export const parseUserPatch = parsePatch(userPatchSchema);
export const parseProjectPatch = parsePatch(projectPatchSchema);

const applyVariablesPatch = (current: EnvironmentVariables | undefined, patch: z.infer<typeof variablesPatchSchema> | undefined) => {
  const next = { ...current };
  for (const [name, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  if (Object.keys(next).length > MAX_VARIABLES) throw new EnvironmentPatchError(`At most ${MAX_VARIABLES} variables`);
  return next;
};

const describeVariables = (variables: EnvironmentVariables | undefined) => Object.keys(variables ?? {}).sort();

const hasErrorCode = (value: unknown): value is { code: unknown } => value !== null
  && typeof value === 'object' && 'code' in value;

export type EnvironmentStore = ReturnType<typeof createEnvironmentStore>;

export const createEnvironmentStore = ({ filePath }: { filePath: string }) => {
  let writeQueue: Promise<EnvironmentDocument | void> = Promise.resolve();
  let cached: EnvironmentDocument | null = null;

  const read = () => {
    if (cached) return cached;
    cached = readFromDisk();
    return cached;
  };

  const readFromDisk = (): EnvironmentDocument => {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      const code = hasErrorCode(error) ? error.code : undefined;
      if (code === 'ENOENT') return { version: 1 };
      throw new EnvironmentStoreError(`environment.json is unreadable: ${code ?? 'error'}`);
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

  const write = (document: EnvironmentDocument) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    cached = document;
  };

  const mutate = (change: (document: EnvironmentDocument) => EnvironmentDocument) => {
    const run = writeQueue.then(() => {
      const next = change(read());
      write(next);
      return next;
    });
    writeQueue = run.catch(() => undefined);
    return run;
  };

  const userVariables = () => ({ ...(read().user?.variables ?? {}) });

  const storedProject = (document: EnvironmentDocument, projectId: string) => (
    document.projects && Object.hasOwn(document.projects, projectId) ? document.projects[projectId] : undefined
  );

  const projectEntry = (projectId: string) => {
    const entry = storedProject(read(), projectId);
    return {
      variables: { ...(entry?.variables ?? {}) },
      command: entry?.command ?? null,
    };
  };

  const hasProjectEntries = () => Object.keys(read().projects ?? {}).length > 0;

  const describeUser = () => ({ names: describeVariables(read().user?.variables) });

  const describeProject = (projectId: string) => {
    const entry = storedProject(read(), projectId);
    return { names: describeVariables(entry?.variables), command: entry?.command ?? null };
  };

  const updateUser = async (body: z.input<typeof userPatchSchema>) => {
    const patch = parseUserPatch(body);
    const next = await mutate((document) => {
      const variables = applyVariablesPatch(document.user?.variables, patch.variables);
      const { user: _user, ...rest } = document;
      return Object.keys(variables).length > 0 ? { ...rest, user: { variables } } : rest;
    });
    return { names: describeVariables(next.user?.variables) };
  };

  const updateProject = async (projectId: string, body: z.input<typeof projectPatchSchema>) => {
    if (!isProjectId(projectId)) throw new EnvironmentPatchError('Invalid project id');
    const patch = parseProjectPatch(body);
    const next = await mutate((document) => {
      const current = storedProject(document, projectId) ?? {};
      const variables = applyVariablesPatch(current.variables, patch.variables);
      const command = patch.command === undefined ? current.command : (patch.command || undefined);
      const entry: StoredProject = {};
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
