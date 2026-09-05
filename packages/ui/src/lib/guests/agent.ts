import { z } from 'zod';

import {
  resolveHostRequestErrorCode,
  type AgentStatus,
  type GuestRequest,
  type HostRequestErrorCode,
} from '@openchamber/sdk';

import { runtimeFetch } from '@/lib/runtime-fetch';

import type { GuestRequestProxyResult } from './oauth';

const requestResultSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.string(),
});

const requestFailureSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1).optional(),
});

const agentStatusSchema = z.object({
  status: z.enum(['stopped', 'starting', 'ready', 'failed']),
});

const requestFailed = (
  code: HostRequestErrorCode,
  message: string,
): GuestRequestProxyResult => ({ ok: false, code, message });

const parseGuestAgentProxyResponse = async (
  response: Response,
): Promise<GuestRequestProxyResult> => {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = requestFailureSchema.safeParse(body);
    if (!parsed.success) {
      return requestFailed('HOST_REJECTED', 'Request failed.');
    }
    return requestFailed(
      resolveHostRequestErrorCode(parsed.data.error),
      parsed.data.message ?? parsed.data.error,
    );
  }
  const parsed = requestResultSchema.safeParse(body);
  if (!parsed.success) {
    return requestFailed('HOST_REJECTED', 'Request failed.');
  }
  return { ok: true, result: parsed.data };
};

export const proxyGuestAgentRequest = async (
  guestId: string,
  request: GuestRequest,
): Promise<GuestRequestProxyResult> => {
  try {
    const response = await runtimeFetch(`/api/guests/${guestId}/agent/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return parseGuestAgentProxyResponse(response);
  } catch {
    return requestFailed('HOST_REJECTED', 'Request failed.');
  }
};

export const loadGuestAgentStatus = async (
  guestId: string,
): Promise<{ ok: true; result: { status: AgentStatus } } | { ok: false; code: HostRequestErrorCode; message: string }> => {
  try {
    const response = await runtimeFetch(`/api/guests/${guestId}/agent/status`);
    if (!response.ok) {
      return { ok: false, code: 'NO_AGENT', message: 'No agent for this extension.' };
    }
    const parsed = agentStatusSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return { ok: false, code: 'HOST_REJECTED', message: 'Agent status was empty.' };
    }
    return { ok: true, result: parsed.data };
  } catch {
    return { ok: false, code: 'HOST_REJECTED', message: 'Could not read agent status.' };
  }
};

export const grantGuestAgent = async (guestId: string): Promise<boolean> => {
  try {
    const response = await runtimeFetch(`/api/guests/${guestId}/agent/grant`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return response.ok;
  } catch {
    return false;
  }
};
