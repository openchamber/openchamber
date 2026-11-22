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
  secrets: variablesSchema.optional(),
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
  user: z.object({ variables: variablesSchema.optional(), secrets: variablesSchema.optional() }).optional(),
  projects: z.record(z.string().refine(isProjectId), projectEntrySchema).optional(),
});
type EnvironmentDocument = z.infer<typeof storeSchema>;
type StoredProject = z.infer<typeof projectEntrySchema>;
type StoredUser = NonNullable<EnvironmentDocument['user']>;

const variablesPatchSchema = z.record(variableName, z.union([variableValue, z.null()]));
const userPatchSchema = z.object({ variables: variablesPatchSchema.optional(), secrets: variablesPatchSchema.optional() }).strict();
const projectPatchSchema = z.object({
  variables: variablesPatchSchema.optional(),
  command: z.union([z.literal(''), z.null(), commandSchema]).optional(),
  secrets: variablesPatchSchema.optional(),
}).strict();

type UserPatch = z.infer<typeof userPatchSchema>;
type ProjectPatch = z.infer<typeof projectPatchSchema>;

export class EnvironmentStoreError extends Error {}

export class EnvironmentPatchError extends Error {}

export class EnvironmentConflictError extends Error {}

const SPACE_SECRETS_MESSAGE = 'Saved secrets are kept on the host; an isolated space cannot save them';

const ownValue = (record: EnvironmentVariables | undefined, key: string) => (record && Object.hasOwn(record, key) ? record[key] : undefined);

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

export const createEnvironmentStore = ({ filePath, savesSecrets = true }: { filePath: string; savesSecrets?: boolean }) => {
  const assertSavesSecrets = (patch: { secrets?: unknown }) => {
    if (!savesSecrets && patch.secrets !== undefined) throw new EnvironmentPatchError(SPACE_SECRETS_MESSAGE);
  };

  let writeQueue: Promise<EnvironmentDocument | void> = Promise.resolve();
  let cached: EnvironmentDocument | null = null;

  const read = () => {
    if (cached) return cached;
    cached = readFromDisk();
    return cached;
  };

  const readFromDisk = (): EnvironmentDocument => {
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
      const code = hasErrorCode(error) ? error.code : undefined;
      throw new EnvironmentStoreError(`environment.json is unreadable: ${code ?? 'error'}`);
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

  const write = (document: EnvironmentDocument) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporaryPath, filePath);
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

  const userSecrets = () => ({ ...(read().user?.secrets ?? {}) });

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

  const projectSecrets = (projectId: string) => ({ ...(storedProject(read(), projectId)?.secrets ?? {}) });

  const hasProjectEntries = () => Object.values(read().projects ?? {}).some((entry) => entry.variables !== undefined || entry.command !== undefined);

  const describeUserEntry = (user: StoredUser | undefined) => ({ names: describeVariables(user?.variables), secrets: describeVariables(user?.secrets) });

  const describeUser = () => describeUserEntry(read().user);

  const describeEntry = (entry: StoredProject | undefined) => ({
    names: describeVariables(entry?.variables),
    command: entry?.command ?? null,
    secrets: describeVariables(entry?.secrets),
  });

  const describeProject = (projectId: string) => describeEntry(storedProject(read(), projectId));

  const patchUser = (document: EnvironmentDocument, patch: UserPatch): EnvironmentDocument => {
    const variables = applyVariablesPatch(document.user?.variables, patch.variables);
    const secrets = applyVariablesPatch(document.user?.secrets, patch.secrets);
    const user: StoredUser = {};
    if (Object.keys(variables).length > 0) user.variables = variables;
    if (Object.keys(secrets).length > 0) user.secrets = secrets;
    const { user: _user, ...rest } = document;
    return Object.keys(user).length > 0 ? { ...rest, user } : rest;
  };

  const patchProject = (document: EnvironmentDocument, projectId: string, patch: ProjectPatch): EnvironmentDocument => {
    const current = storedProject(document, projectId) ?? {};
    const variables = applyVariablesPatch(current.variables, patch.variables);
    const command = patch.command === undefined ? current.command : (patch.command || undefined);
    const secrets = applyVariablesPatch(current.secrets, patch.secrets);
    const entry: StoredProject = {};
    if (Object.keys(variables).length > 0) entry.variables = variables;
    if (command) entry.command = command;
    if (Object.keys(secrets).length > 0) entry.secrets = secrets;
    const projects = { ...(document.projects ?? {}) };
    if (Object.keys(entry).length > 0) projects[projectId] = entry;
    else delete projects[projectId];
    const { projects: _projects, ...rest } = document;
    return Object.keys(projects).length > 0 ? { ...rest, projects } : rest;
  };

  const updateUser = async (body: z.input<typeof userPatchSchema>) => {
    const patch = parseUserPatch(body);
    assertSavesSecrets(patch);
    const next = await mutate((document) => patchUser(document, patch));
    return describeUserEntry(next.user);
  };

  const updateProject = async (projectId: string, body: z.input<typeof projectPatchSchema>) => {
    if (!isProjectId(projectId)) throw new EnvironmentPatchError('Invalid project id');
    const patch = parseProjectPatch(body);
    assertSavesSecrets(patch);
    const next = await mutate((document) => patchProject(document, projectId, patch));
    return describeEntry(storedProject(next, projectId));
  };

  const removeSecrets = async (projectId: string | null, expected: { project: EnvironmentVariables; global: EnvironmentVariables }) => {
    if (projectId !== null && !isProjectId(projectId)) throw new EnvironmentPatchError('Invalid project id');
    assertSavesSecrets({ secrets: expected });
    await mutate((document) => {
      const projectSaved = projectId ? storedProject(document, projectId)?.secrets : undefined;
      const changed = [
        ...Object.entries(expected.project).filter(([env, value]) => ownValue(projectSaved, env) !== value),
        ...Object.entries(expected.global).filter(([env, value]) => ownValue(document.user?.secrets, env) !== value),
      ].map(([env]) => env);
      if (changed.length > 0) throw new EnvironmentConflictError(`${[...new Set(changed)].join(', ')} changed since it was shown`);
      const removal = (names: EnvironmentVariables) => Object.fromEntries(Object.keys(names).map((env) => [env, null]));
      let next = document;
      if (Object.keys(expected.global).length > 0) next = patchUser(next, { secrets: removal(expected.global) });
      if (projectId && Object.keys(expected.project).length > 0) next = patchProject(next, projectId, { secrets: removal(expected.project) });
      return next;
    });
  };

  return { userVariables, userSecrets, projectEntry, projectSecrets, hasProjectEntries, describeUser, describeProject, updateUser, updateProject, removeSecrets };
};
