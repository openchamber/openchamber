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

export const requestReauthProof = async (input: WorkspaceReauthProofRequest): Promise<WorkspaceReauthProofResult> => {
  const binding = {
    operation: input.operation,
    project: input.project,
    bodyHash: await sha256(JSON.stringify(canonicalize(input.payload))),
    nonce: crypto.randomUUID(),
  };
  if (input.password === undefined) {
    return reauthenticateWithPasskey(binding) as Promise<WorkspaceReauthProofResult>;
  }
  const response = await runtimeFetch('/auth/reauth', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...binding, password: input.password }),
  });
  const payload = await response.json().catch(() => null) as (WorkspaceReauthProofResult & { error?: string }) | null;
  if (!response.ok || typeof payload?.proof !== 'string') {
    throw new Error(payload?.error || response.statusText || 'Reauthentication failed');
  }
  return payload;
};
