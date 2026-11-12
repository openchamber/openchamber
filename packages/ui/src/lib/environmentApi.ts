import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Environment variables for what the server starts: the managed OpenCode,
 * Git, the terminal and command execution (`/api/environment`). Values can
 * be API tokens, so they stay on the server; the UI learns only the names
 * and can set or remove a value, never read it back. Not available in VS Code,
 * which runs no OpenChamber server.
 */

/** Same rule as the server: an environment identifier. */
export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const userEnvironmentSchema = z.object({
  names: z.array(z.string()),
});

const commandStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('applied'), count: z.number() }),
  z.object({ state: z.literal('failed'), reason: z.string(), exitCode: z.number().nullable().optional() }),
]);

const projectEnvironmentSchema = z.object({
  names: z.array(z.string()),
  command: z.string().nullable(),
  status: commandStatusSchema.nullable(),
});

type UserEnvironment = z.infer<typeof userEnvironmentSchema>;
export type ProjectEnvironment = z.infer<typeof projectEnvironmentSchema>;
export type EnvironmentCommandStatus = z.infer<typeof commandStatusSchema>;

/** A string sets the variable, null removes it. */
export type EnvironmentVariablesPatch = Record<string, string | null>;

const readJson = async <T>(response: Response, schema: z.ZodType<T>, failure: string): Promise<T> => {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = z.object({ error: z.string() }).safeParse(body);
    throw new Error(message.success ? message.data.error : `${failure}: ${response.status}`);
  }
  return schema.parse(await response.json());
};

type EnvironmentUpdate = { variables?: EnvironmentVariablesPatch; command?: string | null };

const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

const putRequest = (update: EnvironmentUpdate): RequestInit => ({
  method: 'PUT',
  headers: jsonHeaders,
  body: JSON.stringify(update),
});

const projectPath = (projectId: string): string => `/api/environment/projects/${encodeURIComponent(projectId)}`;

export const fetchUserEnvironment = async (): Promise<UserEnvironment> => readJson(
  await runtimeFetch('/api/environment', { headers: { Accept: 'application/json' } }),
  userEnvironmentSchema,
  'Failed to read environment variables',
);

export const updateUserEnvironment = async (variables: EnvironmentVariablesPatch): Promise<UserEnvironment> => readJson(
  await runtimeFetch('/api/environment', putRequest({ variables })),
  userEnvironmentSchema,
  'Failed to save environment variables',
);

export const fetchProjectEnvironment = async (projectId: string): Promise<ProjectEnvironment> => readJson(
  await runtimeFetch(projectPath(projectId), { headers: { Accept: 'application/json' } }),
  projectEnvironmentSchema,
  'Failed to read project environment',
);

export const updateProjectEnvironment = async (
  projectId: string,
  patch: EnvironmentUpdate,
): Promise<ProjectEnvironment> => readJson(
  await runtimeFetch(projectPath(projectId), putRequest(patch)),
  projectEnvironmentSchema,
  'Failed to save project environment',
);

/** Runs the project's environment command now and answers its outcome. */
export const reloadProjectEnvironment = async (projectId: string): Promise<ProjectEnvironment> => readJson(
  await runtimeFetch(`${projectPath(projectId)}/reload`, { method: 'POST', headers: jsonHeaders }),
  projectEnvironmentSchema,
  'Failed to run the environment command',
);
