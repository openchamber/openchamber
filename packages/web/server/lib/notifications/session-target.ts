import { isString } from './inputs.js';

export const buildSessionDeepLinkUrl = (sessionId: string | undefined, messageId?: string | undefined) => {
  if (!sessionId) return '/';
  const session = `/?session=${encodeURIComponent(sessionId)}`;
  return messageId ? `${session}&message=${encodeURIComponent(messageId)}` : session;
};

export const messageTargetOf = (info: { id?: unknown } | null | undefined): string | undefined => (
  isString(info?.id) ? info.id : undefined
);
