
import { z } from 'zod';

import type { Message } from '@/lib/opencode/model';

import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from './providerAuthError';

export const STOPPED_TURN_MESSAGE = 'The running turn was stopped before OpenCode could send the next message.';

const ABORT_ERROR_NAME = 'MessageAbortedError';

const STOPPED_DETAILS: ReadonlySet<string> = new Set(['aborted', 'step interrupted']);

const normalizeDetail = (detail: string): string => (
  detail.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '')
);

export const isStoppedTurnError = (name: string | undefined, detail: string): boolean => {
  if (name === ABORT_ERROR_NAME) {
    return true;
  }
  return STOPPED_DETAILS.has(normalizeDetail(detail));
};

const assistantErrorPayload = z.object({
    name: z.string().optional(),
    type: z.string().optional(),
    message: z.string().optional(),
    data: z.object({ message: z.string().optional() }).optional(),
});

type AssistantErrorDetail = {
    name?: string;
    detail: string;
};

const readAssistantErrorDetail = (info: Message): AssistantErrorDetail | null => {
    if (info.role !== 'assistant') {
        return null;
    }
    const parsed = assistantErrorPayload.safeParse(info.error);
    if (!parsed.success) {
        return null;
    }
    const { name, type, message, data } = parsed.data;
    const errorName = name ?? type;
    const detail = data?.message || message || errorName;
    return detail ? { name: errorName, detail } : null;
};

type AssistantErrorNotice = { text: string };

export const assistantErrorNotice = (info: Message): AssistantErrorNotice | null => {
    const errorDetail = readAssistantErrorDetail(info);
    if (!errorDetail) {
        return null;
    }
    const { name: errorName, detail } = errorDetail;
    if (errorName === 'SessionRetry') {
        return { text: `Opencode failed to send a message. Retry attempt info: ${detail}` };
    }
    if (isLikelyProviderAuthFailure(detail)) {
        return { text: PROVIDER_AUTH_FAILURE_MESSAGE };
    }
    if (isStoppedTurnError(errorName, detail)) {
        return { text: STOPPED_TURN_MESSAGE };
    }
    return { text: `Opencode failed to send message with error: ${detail}` };
};
