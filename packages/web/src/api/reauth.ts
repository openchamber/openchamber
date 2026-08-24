import type {
  WorkspaceReauthProofRequest,
  WorkspaceReauthProofResult,
} from '@openchamber/ui/lib/api/types';
import { reauthenticateWithPasskey } from '@openchamber/ui/lib/passkeys';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const postReauth = async (body: Record<string, unknown>): Promise<{ response: Response; payload: (WorkspaceReauthProofResult & { error?: string; stepUpRequired?: boolean; setupRequired?: boolean }) | null }> => {
  const response = await runtimeFetch('/auth/reauth', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as (WorkspaceReauthProofResult & { error?: string; stepUpRequired?: boolean; setupRequired?: boolean }) | null;
  return { response, payload };
};

const reauthFailure = (response: Response, payload: { error?: string; stepUpRequired?: boolean; setupRequired?: boolean } | null): Error =>
  Object.assign(new Error(payload?.error || response.statusText || 'Reauthentication failed'), {
    stepUpRequired: payload?.stepUpRequired === true,
    setupRequired: payload?.setupRequired === true,
    status: response.status,
  });

export const requestReauthProof = async (input: WorkspaceReauthProofRequest): Promise<WorkspaceReauthProofResult> => {
  const binding = {
    operation: input.operation,
    project: input.project,
    bodyHash: await sha256(JSON.stringify(canonicalize(input.payload))),
    nonce: crypto.randomUUID(),
  };
  if (input.password === undefined) {
    // A still-valid step-up window mints the proof without any user interaction.
    const probe = await postReauth(binding);
    if (probe.response.ok && typeof probe.payload?.proof === 'string') return probe.payload;
    if (probe.payload?.setupRequired) throw reauthFailure(probe.response, probe.payload);
    return reauthenticateWithPasskey(binding) as Promise<WorkspaceReauthProofResult>;
  }
  const { response, payload } = await postReauth({ ...binding, password: input.password });
  if (!response.ok || typeof payload?.proof !== 'string') {
    throw reauthFailure(response, payload);
  }
  return payload;
};
