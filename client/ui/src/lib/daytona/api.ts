import { runtimeFetch } from '@/lib/runtime-fetch';
import type { SandboxInfo } from '@/stores/useDaytonaSandboxStore';

interface CreateSandboxResponse {
  sandboxId: string;
  sessionId: string;
  status: string;
  openCodeUrl: string | null;
  createdAt: string;
}

interface SandboxStatusResponse {
  sandboxId: string;
  sessionId: string;
  status: string;
  openCodeUrl: string | null;
  createdAt: string;
  lastActivityAt?: string;
}

interface ListSandboxesResponse {
  sandboxes: SandboxStatusResponse[];
}

export async function createDaytonaSandbox(sessionId: string): Promise<SandboxInfo> {
  const response = await runtimeFetch('/api/daytona/sandbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to create sandbox: ${response.status} ${errorBody}`);
  }

  const data: CreateSandboxResponse = await response.json();
  return {
    sandboxId: data.sandboxId,
    sessionId: data.sessionId,
    status: data.status as SandboxInfo['status'],
    openCodeUrl: data.openCodeUrl,
    createdAt: data.createdAt,
  };
}

export async function destroyDaytonaSandbox(sessionId: string): Promise<void> {
  const response = await runtimeFetch(`/api/daytona/sandbox/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to destroy sandbox: ${response.status} ${errorBody}`);
  }
}

export async function getSandboxStatus(sessionId: string): Promise<SandboxInfo> {
  const response = await runtimeFetch(`/api/daytona/sandbox/${encodeURIComponent(sessionId)}/status`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to get sandbox status: ${response.status} ${errorBody}`);
  }

  const data: SandboxStatusResponse = await response.json();
  return {
    sandboxId: data.sandboxId,
    sessionId: data.sessionId,
    status: data.status as SandboxInfo['status'],
    openCodeUrl: data.openCodeUrl,
    createdAt: data.createdAt,
  };
}

export async function sendActivityHeartbeat(sessionId: string): Promise<void> {
  const response = await runtimeFetch(`/api/daytona/sandbox/${encodeURIComponent(sessionId)}/activity`, {
    method: 'POST',
  });

  if (!response.ok) {
    console.warn(`[daytona] heartbeat failed for session ${sessionId}: ${response.status}`);
  }
}

export async function listActiveSandboxes(): Promise<SandboxInfo[]> {
  const response = await runtimeFetch('/api/daytona/sandboxes', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Failed to list sandboxes: ${response.status} ${errorBody}`);
  }

  const data: ListSandboxesResponse = await response.json();
  return (data.sandboxes ?? []).map((s) => ({
    sandboxId: s.sandboxId,
    sessionId: s.sessionId,
    status: s.status as SandboxInfo['status'],
    openCodeUrl: s.openCodeUrl,
    createdAt: s.createdAt,
  }));
}
