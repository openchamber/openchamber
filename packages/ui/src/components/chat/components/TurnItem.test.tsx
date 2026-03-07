import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import TurnItem from './TurnItem';
import type { ChatMessageEntry, Turn } from '../lib/turns/types';

const assert = (condition: unknown, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

const makeMessage = (id: string, role: 'user' | 'assistant'): ChatMessageEntry => ({
    info: {
        id,
        role,
        sessionID: 's1',
        time: { created: 1 },
    } as Message,
    parts: [{ type: 'text', text: id } as unknown as Part],
});

export const runTurnItemTests = (): void => {
    const user = makeMessage('u1', 'user');
    const assistant = makeMessage('a1', 'assistant');

    const turn: Turn = {
        turnId: 'u1',
        userMessage: user,
        assistantMessages: [assistant],
    };

    const html = renderToStaticMarkup(
        <TurnItem
            turn={turn}
            stickyUserHeader={false}
            renderMessage={(message) => <div data-message-id={message.info.id}>{message.info.id}</div>}
        />,
    );

    assert(html.includes('data-turn-id="u1"'), 'turn item should expose turn id anchor');
    assert(html.includes('data-message-id="u1"'), 'turn item should render user anchor message');
    assert(html.includes('data-message-id="a1"'), 'turn item should render assistant message block');
};
