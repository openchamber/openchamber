import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { isSyntheticPart } from './synthetic';

type MessageTextPart = Part & { text?: string; content?: string };

export type RestorableMessagePayload = {
  messageText: string;
  fileParts: Array<Record<string, unknown>>;
};

export const extractRestorableMessagePayload = (
  message: Message | null | undefined,
  parts: Part[] | undefined,
): RestorableMessagePayload | null => {
  if (!message || message.role !== 'user') return null;

  const safeParts = parts ?? [];
  const textParts = safeParts
    .filter((part): part is MessageTextPart => part?.type === 'text' && !isSyntheticPart(part))
    .map((part) => (part.text || part.content || '').trim())
    .filter((text) => text.length > 0);

  const fileParts = safeParts
    .filter((part) => part?.type === 'file' && !isSyntheticPart(part))
    .map((part) => part as Record<string, unknown>);

  return {
    messageText: textParts.join('\n').trim(),
    fileParts,
  };
};
