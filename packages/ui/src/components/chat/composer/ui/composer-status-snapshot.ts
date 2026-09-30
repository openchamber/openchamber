import type { ComposerStatusSnapshot } from '@openchamber/sdk';
import type { Message } from '@/lib/opencode/model';

/** The engine this host runs its sessions on. */
export const COMPOSER_STATUS_ENGINE = 'opencode';

const isCompletedAssistantMessage = (message: Message): message is Extract<Message, { role: 'assistant' }> =>
  message.role === 'assistant'
  && (message.time.completed !== undefined || Boolean(message.finish) || Boolean(message.error));

const getLatestCompletedAssistantMessage = (
  messages: readonly Message[],
): Extract<Message, { role: 'assistant' }> | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isCompletedAssistantMessage(message)) return message;
  }
  return null;
};

/**
 * The composer-status snapshot for one session, computed from the sync's
 * message bucket. Pure: the caller reads the messages and the engine and
 * passes them in, so this stays testable and never touches sync context.
 * Without a session or a completed assistant turn the snapshot still exists
 * with `null` fields — the contract is always a snapshot, never an absence.
 */
export const buildComposerStatusSnapshot = ({
  sessionId,
  engine,
  messages,
}: {
  sessionId: string | null;
  engine: string;
  messages: readonly Message[];
}): ComposerStatusSnapshot => {
  const last = sessionId ? getLatestCompletedAssistantMessage(messages) : null;
  return {
    sessionId: sessionId ?? '',
    engine,
    providerId: last?.providerID ?? null,
    lastAssistantAt: last?.time.completed ?? last?.time.created ?? null,
  };
};
