import { runtimeFetch } from '@/lib/runtime-fetch';

export type SessionReferencePayload = {
  ok: true;
  sessionId: string;
  reference: string;
  discordUrl: string | null;
  shareUrl: string | null;
  title: string | null;
  directory: string | null;
  projectLabel: string | null;
};

export async function fetchSessionReference(sessionId: string): Promise<SessionReferencePayload | null> {
  const encoded = encodeURIComponent(sessionId);
  const response = await runtimeFetch(`/api/messenger/agent/session-reference/${encoded}`);
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null) as SessionReferencePayload | { ok?: false } | null;
  if (!payload || payload.ok !== true || typeof payload.reference !== 'string') {
    return null;
  }
  return payload;
}
