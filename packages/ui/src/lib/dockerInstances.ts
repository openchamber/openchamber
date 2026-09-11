/**
 * Client for OpenChamber's Docker-backed OpenCode instance APIs.
 *
 * OpenChamber-owned routes go through `runtimeFetch` (never raw fetch), and
 * every payload is parsed with a zod schema at this boundary into a trusted
 * contract before it reaches components. Fetch failures throw — a failed
 * authoritative fetch is never converted into a valid empty list.
 */

import { z } from 'zod';

const lifecycleStateSchema = z.enum([
  'creating',
  'starting',
  'probing',
  'running',
  'stopped',
  'error',
  'removing',
  'removal-failed',
]);

export type DockerInstanceLifecycleState = z.infer<typeof lifecycleStateSchema>;

type DockerInstanceAction = 'start' | 'stop' | 'remove' | 'cleanup';

const sharingSchema = z.object({
  config: z.boolean().catch(false),
  skills: z.boolean().catch(false),
  credentials: z.boolean().catch(false),
  skillsHostDir: z.string().trim().min(1).nullable().catch(null),
});

const dockerInstanceRecordSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1).catch(''),
  image: z.string().trim().catch(''),
  containerId: z.string().trim().min(1).nullable().catch(null),
  containerName: z.string().trim().catch(''),
  port: z.number().int().positive().nullable().catch(null),
  workspaceHostPath: z.string().trim().catch(''),
  workspaceContainerPath: z.string().trim().catch('/workspace'),
  sharing: sharingSchema.catch({
    config: false,
    skills: false,
    credentials: false,
    skillsHostDir: null,
  }),
  lifecycleState: lifecycleStateSchema.catch('error'),
  lastError: z.string().trim().min(1).nullable().catch(null),
  createdAt: z.number().int().catch(0),
}).transform((record) => ({
  ...record,
  label: record.label || record.id,
}));

type DockerInstanceSharing = z.infer<typeof sharingSchema>;
export type DockerInstanceRecord = z.infer<typeof dockerInstanceRecordSchema>;

const dockerInstancesSnapshotSchema = z.object({
  enabled: z.boolean().catch(false),
  instances: z.array(dockerInstanceRecordSchema.nullable().catch(null)).catch([]).transform(
    (list) => list.filter((entry): entry is DockerInstanceRecord => entry !== null),
  ),
  activeInstanceId: z.string().trim().min(1).nullable().catch(null),
  sharedSkillsHostPath: z.string().trim().min(1).nullable().catch(null),
}).transform((snapshot) => ({
  ...snapshot,
  activeInstanceId: snapshot.instances.some((instance) => instance.id === snapshot.activeInstanceId)
    ? snapshot.activeInstanceId
    : null,
}));

export type DockerInstancesSnapshot = z.infer<typeof dockerInstancesSnapshotSchema>;

interface CreateDockerInstanceInput {
  label?: string;
  workspaceHostPath: string;
  sharing?: { config?: boolean; skills?: boolean; credentials?: boolean; skillsHostDir?: string };
  image?: string;
  port?: number;
}

const apiErrorPayloadSchema = z.object({
  error: z.string().catch(''),
  code: z.string().nullable().catch(null),
}).nullable().catch(null);

const actionResultSchema = z.looseObject({
  ok: z.boolean().optional(),
}).nullable().catch(null);

class DockerApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DockerApiError';
    this.code = code;
  }
}

const requestJson = async <S extends z.ZodType>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<z.output<S>> => {
  const { runtimeFetch } = await import('@/lib/runtime-fetch');
  const response = await runtimeFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorPayloadSchema.parse(payload);
    throw new DockerApiError(
      parsed?.error || `Request failed (${response.status})`,
      parsed?.code ?? '',
    );
  }
  return schema.parse(payload);
};

export const fetchDockerInstances = async (): Promise<DockerInstancesSnapshot> =>
  requestJson('/api/docker-instances', dockerInstancesSnapshotSchema);

export const createDockerInstance = async (input: CreateDockerInstanceInput): Promise<DockerInstanceRecord> =>
  requestJson('/api/docker-instances', dockerInstanceRecordSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const activateDockerInstance = async (id: string): Promise<void> => {
  await requestJson(`/api/docker-instances/${encodeURIComponent(id)}/activate`, actionResultSchema, { method: 'POST' });
};

export const deactivateDockerInstance = async (): Promise<void> => {
  await requestJson('/api/docker-instances/deactivate', actionResultSchema, { method: 'POST' });
};

export const runDockerInstanceAction = async (id: string, action: DockerInstanceAction): Promise<void> => {
  await requestJson(`/api/docker-instances/${encodeURIComponent(id)}/${action}`, actionResultSchema, { method: 'POST' });
};

export const buildDockerInstanceImage = async (imageName?: string): Promise<void> => {
  await requestJson('/api/docker-instances/image/build', actionResultSchema, {
    method: 'POST',
    body: JSON.stringify(imageName ? { imageName } : {}),
  });
};

export const pullDockerInstanceImage = async (imageName?: string): Promise<void> => {
  await requestJson('/api/docker-instances/image/pull', actionResultSchema, {
    method: 'POST',
    body: JSON.stringify(imageName ? { imageName } : {}),
  });
};

/** Fired after the active upstream changed so listeners can refresh state. */
export const DOCKER_UPSTREAM_CHANGED_EVENT = 'openchamber:docker-upstream-changed';

export const notifyUpstreamChanged = () => {
  globalThis.dispatchEvent?.(new CustomEvent(DOCKER_UPSTREAM_CHANGED_EVENT));
};

export { DockerApiError };
