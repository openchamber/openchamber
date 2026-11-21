import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';


export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const userEnvironmentSchema = z.object({
  names: z.array(z.string()),
  secrets: z.array(z.string()).default([]),
});

const commandStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('applied'), count: z.number() }),
  z.object({ state: z.literal('failed'), reason: z.string(), exitCode: z.number().nullable().optional() }),
]);

const projectEnvironmentSchema = z.object({
  names: z.array(z.string()),
  command: z.string().nullable(),
  secrets: z.array(z.string()).default([]),
  status: commandStatusSchema.nullable(),
});

type UserEnvironment = z.infer<typeof userEnvironmentSchema>;
export type ProjectEnvironment = z.infer<typeof projectEnvironmentSchema>;
export type EnvironmentCommandStatus = z.infer<typeof commandStatusSchema>;

export type EnvironmentVariablesPatch = Record<string, string | null>;

const readJson = async <T>(response: Response, schema: z.ZodType<T>, failure: string): Promise<T> => {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = z.object({ error: z.string() }).safeParse(body);
    throw new Error(message.success ? message.data.error : `${failure}: ${response.status}`);
  }
  return schema.parse(await response.json());
};

export type EnvironmentUpdate = { variables?: EnvironmentVariablesPatch; command?: string | null; secrets?: Record<string, null> };

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

export const updateUserEnvironment = async (update: Pick<EnvironmentUpdate, 'variables' | 'secrets'>): Promise<UserEnvironment> => readJson(
  await runtimeFetch('/api/environment', putRequest(update)),
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

export const reloadProjectEnvironment = async (projectId: string): Promise<ProjectEnvironment> => readJson(
  await runtimeFetch(`${projectPath(projectId)}/reload`, { method: 'POST', headers: jsonHeaders }),
  projectEnvironmentSchema,
  'Failed to run the environment command',
);
