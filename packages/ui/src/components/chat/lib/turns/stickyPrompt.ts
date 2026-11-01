import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import type { ChatMessageEntry } from './types';

/**
 * A hidden prompt has nothing to pin, and a turn opened by anything but a
 * prompt (a background report, a compaction, a notice after an answer) opens
 * as a notice row, which never sticks.
 */
export const turnHeaderCanStick = (userMessage: ChatMessageEntry): boolean => (
    userMessage.info.role === 'user' && !isHiddenUserMessage(userMessage)
);
