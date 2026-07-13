import { describe, expect, test } from 'bun:test';
import {
    buildTurnOutlineItems,
    getRailTurnOutlineItems,
    type TurnOutlineItem,
} from './turnHoverOutlineItems';
import type { ChatMessageEntry } from './lib/turns/types';
import type { TurnWindowModel } from './lib/turns/windowTurns';

const makeItems = (count: number): TurnOutlineItem[] =>
    Array.from({ length: count }, (_, index) => ({
        turnId: `turn-${index + 1}`,
        preview: `Turn ${index + 1}`,
    }));

describe('TurnHoverOutline item selection', () => {
    test('builds outline items in authoritative turn order from user messages', () => {
        const messages = [
            {
                info: {
                    id: 'turn-1',
                    sessionID: 'session-1',
                    role: 'user',
                    time: { created: 20 },
                    agent: 'build',
                    model: { providerID: 'provider-1', modelID: 'model-1' },
                },
                parts: [{
                    id: 'part-1',
                    sessionID: 'session-1',
                    messageID: 'turn-1',
                    type: 'text',
                    text: 'First\nquestion',
                }],
            },
            {
                info: {
                    id: 'assistant-1',
                    sessionID: 'session-1',
                    role: 'assistant',
                    parentID: 'turn-1',
                    time: { created: 21 },
                    modelID: 'model-1',
                    providerID: 'provider-1',
                    mode: 'build',
                    agent: 'build',
                    path: { cwd: '/workspace', root: '/workspace' },
                    cost: 0,
                    tokens: {
                        input: 0,
                        output: 0,
                        reasoning: 0,
                        cache: { read: 0, write: 0 },
                    },
                },
                parts: [{
                    id: 'part-2',
                    sessionID: 'session-1',
                    messageID: 'assistant-1',
                    type: 'text',
                    text: 'Answer',
                }],
            },
            {
                info: {
                    id: 'turn-2',
                    sessionID: 'session-1',
                    role: 'user',
                    time: { created: 10 },
                    agent: 'build',
                    model: { providerID: 'provider-1', modelID: 'model-1' },
                },
                parts: [{
                    id: 'part-3',
                    sessionID: 'session-1',
                    messageID: 'turn-2',
                    type: 'text',
                    text: 'Second question',
                }],
            },
        ] satisfies ChatMessageEntry[];
        const turnWindowModel = {
            turnIds: ['turn-1', 'turn-2'],
            turnMessageStartIndexes: [0, 2],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;

        expect(buildTurnOutlineItems(messages, turnWindowModel)).toEqual([
            { turnId: 'turn-1', preview: 'First question' },
            { turnId: 'turn-2', preview: 'Second question' },
        ]);
    });

    test('returns the previous array for an assistant-only replacement', () => {
        const messages = [
            {
                info: { id: 'turn-1', role: 'user' },
                parts: [{ type: 'text', text: 'First question' }],
            },
            {
                info: { id: 'assistant-1', role: 'assistant' },
                parts: [{ type: 'text', text: 'Streaming response' }],
            },
        ] as ChatMessageEntry[];
        const updatedMessages = [
            messages[0],
            { ...messages[1], parts: [{ type: 'text', text: 'Updated response' }] },
        ] as ChatMessageEntry[];
        const turnWindowModel = {
            turnIds: ['turn-1'],
            turnMessageStartIndexes: [0],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const initialItems = buildTurnOutlineItems(messages, turnWindowModel);
        const updatedItems = buildTurnOutlineItems(
            updatedMessages,
            turnWindowModel,
            initialItems,
        );

        expect(updatedItems).toBe(initialItems);
        expect(updatedItems[0]).toBe(initialItems[0]);
    });

    test('replaces only the item whose user preview changes', () => {
        const messages = [
            {
                info: { id: 'turn-1', role: 'user' },
                parts: [{ type: 'text', text: 'First question' }],
            },
            {
                info: { id: 'turn-2', role: 'user' },
                parts: [{ type: 'text', text: 'Second question' }],
            },
        ] as ChatMessageEntry[];
        const turnWindowModel = {
            turnIds: ['turn-1', 'turn-2'],
            turnMessageStartIndexes: [0, 1],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const initialItems = buildTurnOutlineItems(messages, turnWindowModel);
        const replacementMessages = [{
            ...messages[0],
            parts: [{ type: 'text', text: 'Confirmed question' }],
        }, messages[1]] as ChatMessageEntry[];
        const replacedItems = buildTurnOutlineItems(
            replacementMessages,
            turnWindowModel,
            initialItems,
        );

        expect(replacedItems).not.toBe(initialItems);
        expect(replacedItems[0]).not.toBe(initialItems[0]);
        expect(replacedItems[1]).toBe(initialItems[1]);
    });

    test('preserves existing item identity when a turn is appended', () => {
        const messages = [{
            info: { id: 'turn-1', role: 'user' },
            parts: [{ type: 'text', text: 'First question' }],
        }] as ChatMessageEntry[];
        const turnWindowModel = {
            turnIds: ['turn-1'],
            turnMessageStartIndexes: [0],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const initialItems = buildTurnOutlineItems(messages, turnWindowModel);
        const appendedMessages = [...messages, {
            info: { id: 'turn-2', role: 'user' },
            parts: [{ type: 'text', text: 'Second question' }],
        }] as ChatMessageEntry[];
        const appendedModel = {
            turnIds: ['turn-1', 'turn-2'],
            turnMessageStartIndexes: [0, 1],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const appendedItems = buildTurnOutlineItems(
            appendedMessages,
            appendedModel,
            initialItems,
        );

        expect(appendedItems).not.toBe(initialItems);
        expect(appendedItems[0]).toBe(initialItems[0]);
        expect(appendedItems).toEqual([
            { turnId: 'turn-1', preview: 'First question' },
            { turnId: 'turn-2', preview: 'Second question' },
        ]);
    });

    test('preserves shifted item identity when history is prepended', () => {
        const messages = [{
            info: { id: 'turn-1', role: 'user' },
            parts: [{ type: 'text', text: 'First question' }],
        }] as ChatMessageEntry[];
        const turnWindowModel = {
            turnIds: ['turn-1'],
            turnMessageStartIndexes: [0],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const initialItems = buildTurnOutlineItems(messages, turnWindowModel);
        const historyMessages = [{
            info: { id: 'turn-0', role: 'user' },
            parts: [{ type: 'text', text: 'Earlier question' }],
        }, ...messages] as ChatMessageEntry[];
        const historyModel = {
            turnIds: ['turn-0', 'turn-1'],
            turnMessageStartIndexes: [0, 1],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const historyItems = buildTurnOutlineItems(
            historyMessages,
            historyModel,
            initialItems,
        );

        expect(historyItems).not.toBe(initialItems);
        expect(historyItems[1]).toBe(initialItems[0]);
    });

    test('returns current authoritative order while reusing moved item identities', () => {
        const messages = [{
            info: { id: 'turn-1', role: 'user' },
            parts: [{ type: 'text', text: 'First question' }],
        }, {
            info: { id: 'turn-2', role: 'user' },
            parts: [{ type: 'text', text: 'Second question' }],
        }] as ChatMessageEntry[];
        const initialModel = {
            turnIds: ['turn-1', 'turn-2'],
            turnMessageStartIndexes: [0, 1],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const reorderedModel = {
            turnIds: ['turn-2', 'turn-1'],
            turnMessageStartIndexes: [1, 0],
        } satisfies Pick<TurnWindowModel, 'turnIds' | 'turnMessageStartIndexes'>;
        const initialItems = buildTurnOutlineItems(messages, initialModel);
        const reorderedItems = buildTurnOutlineItems(messages, reorderedModel, initialItems);

        expect(reorderedItems).not.toBe(initialItems);
        expect(reorderedItems.map((item) => item.turnId)).toEqual(['turn-2', 'turn-1']);
        expect(reorderedItems[0]).toBe(initialItems[1]);
        expect(reorderedItems[1]).toBe(initialItems[0]);
    });

    test('keeps every rail marker when there are at most 20 turns', () => {
        const items = makeItems(20);

        expect(getRailTurnOutlineItems(items, 'turn-17')).toEqual(items);
    });

    test('samples long sessions to at most 20 source-ordered markers including boundaries and active turn', () => {
        const items = makeItems(101);
        const railItems = getRailTurnOutlineItems(items, 'turn-52');
        const ids = railItems.map((item) => item.turnId);

        expect(railItems).toHaveLength(20);
        expect(ids).toEqual([...ids].sort((left, right) => Number(left.slice(5)) - Number(right.slice(5))));
        expect(ids).toContain('turn-1');
        expect(ids).toContain('turn-52');
        expect(ids).toContain('turn-101');
    });

    test('broadly spans a long conversation rather than selecting only a few anchor turns', () => {
        const items = makeItems(101);
        const railItems = getRailTurnOutlineItems(items, 'turn-2');
        const indexes = railItems.map((item) => Number(item.turnId.slice(5)) - 1);

        expect(indexes.some((index) => index >= 20 && index < 40)).toBe(true);
        expect(indexes.some((index) => index >= 40 && index < 60)).toBe(true);
        expect(indexes.some((index) => index >= 60 && index < 80)).toBe(true);
    });

});
