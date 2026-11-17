import type { Session } from '@/lib/opencode/model';

export interface SessionAssistPayload {
  recap: string;
  suggestion: string;
  forMessageID: string;
  generatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function getSessionAssist(session: Session | null | undefined): SessionAssistPayload | null {
  const metadata = (session as { metadata?: unknown } | null | undefined)?.metadata;
  if (!isRecord(metadata)) return null;
  const namespace = metadata.openchamber;
  if (!isRecord(namespace)) return null;
  const assist = namespace.assist;
  if (!isRecord(assist)) return null;

  const recap = typeof assist.recap === 'string' ? assist.recap.trim() : '';
  const suggestion = typeof assist.suggestion === 'string' ? assist.suggestion.trim() : '';
  const forMessageID = typeof assist.forMessageID === 'string' ? assist.forMessageID : '';
  if (!forMessageID || (!recap && !suggestion)) return null;

  return {
    recap,
    suggestion,
    forMessageID,
    generatedAt: typeof assist.generatedAt === 'number' ? assist.generatedAt : 0,
  };
}

export function getCurrentSessionAssist(session: Session | null | undefined): SessionAssistPayload | null {
  const assist = getSessionAssist(session);
  if (!assist || !session) return null;
  if (session.revert?.messageID) return null;
  const idleAt = session.time?.idle ?? 0;
  return assist.generatedAt >= idleAt ? assist : null;
}
