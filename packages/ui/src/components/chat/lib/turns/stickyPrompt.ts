import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import type { ChatMessageEntry } from './types';

export const turnHeaderCanStick = (userMessage: ChatMessageEntry): boolean => (
    userMessage.info.role === 'user' && !isHiddenUserMessage(userMessage)
);
