import { afterEach, describe, expect, test } from 'bun:test';

import { createContextPart } from '@/lib/messages/contextParts';
import type { Message, Part } from '@/lib/opencode/model';
import { useMessageSelectionStore } from '@/stores/useMessageSelectionStore';
import type { ChatMessageEntry } from '../lib/turns/types';
import { listSelectableUnits } from './selectableUnits';
import { pickSelectedUnits } from './selectionExport';

let partCounter = 0;
const text = (value: string): Part => ({ id: `p${partCounter++}`, type: 'text', text: value } as Part);
const tool = (): Part => ({ id: `p${partCounter++}`, type: 'tool', tool: 'read', state: { status: 'completed' } } as Part);
const reasoning = (value: string): Part => ({ id: `p${partCounter++}`, type: 'reasoning', text: value } as Part);

const user = (id: string, ...parts: Part[]): ChatMessageEntry => ({
    info: { id, sessionID: 's', role: 'user', time: { created: 1 } } as Message,
    parts,
});

const assistant = (id: string, ...parts: Part[]): ChatMessageEntry => ({
    info: { id, sessionID: 's', role: 'assistant', providerID: 'p', modelID: 'm', time: { created: 2, completed: 3 } } as Message,
    parts,
});

describe('listSelectableUnits', () => {
    test('takes a prompt and its whole answer, without tools and reasoning', () => {
        const units = listSelectableUnits([
            user('u1', text('Why?')),
            assistant('a1', reasoning('hmm'), text('Reading first.'), tool()),
            assistant('a2', tool(), text('Because.')),
            user('u2', text('Thanks')),
        ]);
        expect(units.map((unit) => unit.key)).toEqual(['prompt:u1', 'answer:u1', 'prompt:u2']);
        expect(units[1]).toMatchObject({ kind: 'answer', messageId: 'a2', segments: ['Reading first.', 'Because.'], modelID: 'm' });
    });

    test('keys a prompt sent with a quote the way the timeline does, with the quote in its text', () => {
        const quote: ChatMessageEntry = {
            info: { id: 'c1', sessionID: 's', role: 'synthetic', time: { created: 1 }, ...createContextPart({ kind: 'chat-quote', quote: 'Earlier line', text: 'Why this?' }) } as Message,
            parts: [],
        };
        const units = listSelectableUnits([
            user('u0', text('First')), assistant('a0', text('Earlier line')),
            quote, user('u1', text('Explain')), assistant('a1', text('Because.')),
        ]);
        expect(units.map((unit) => unit.key)).toEqual(['prompt:u0', 'answer:u0', 'prompt:u1', 'answer:u1']);
        const prompt = units[2];
        expect(prompt?.kind === 'prompt' ? prompt.text : '').toBe('Quoted from an earlier message:\n\n> Earlier line\n\n**User comment:**\n\nWhy this?\n\nExplain');
    });

    test('keeps a prompt that is only a quote with a comment', () => {
        const quote: ChatMessageEntry = {
            info: { id: 'c1', sessionID: 's', role: 'synthetic', time: { created: 1 }, ...createContextPart({ kind: 'chat-quote', quote: 'Earlier line', text: 'Why this?' }) } as Message,
            parts: [],
        };
        const units = listSelectableUnits([user('u0', text('First')), assistant('a0', text('Earlier line')), quote, user('u1'), assistant('a1', text('Because.'))]);
        expect(units.map((unit) => unit.key)).toEqual(['prompt:u0', 'answer:u0', 'prompt:u1', 'answer:u1']);
    });

    test('leaves out an answer with no text', () => {
        const units = listSelectableUnits([user('u1', text('Run it')), assistant('a1', tool())]);
        expect(units.map((unit) => unit.key)).toEqual(['prompt:u1']);
    });

    test('reports a selected unit that is gone', () => {
        const records = [user('u1', text('Hi')), assistant('a1', text('Hello'))];
        expect(pickSelectedUnits(records, new Set(['answer:u1', 'prompt:u1'])).complete).toBe(true);
        const picked = pickSelectedUnits(records, new Set(['answer:u1', 'prompt:gone']));
        expect(picked).toMatchObject({ complete: false, units: [{ key: 'answer:u1' }] });
    });
});

describe('useMessageSelectionStore', () => {
    afterEach(() => useMessageSelectionStore.getState().end());

    test('toggles, adds a range from the last click and ends for its own session only', () => {
        const store = useMessageSelectionStore.getState();
        const order = ['prompt:1', 'answer:1', 'prompt:2', 'answer:2'];
        store.begin('s1', 'prompt:1');
        store.toggle('s1', 'answer:1');
        store.toggle('s1', 'answer:1');
        store.selectRange('s1', 'answer:2', order);
        expect([...useMessageSelectionStore.getState().selection!.keys]).toEqual(order);
        store.toggle('s2', 'prompt:9');
        store.end('s2');
        expect(useMessageSelectionStore.getState().selection?.keys.size).toBe(4);
        store.end('s1');
        expect(useMessageSelectionStore.getState().selection).toBeNull();
    });
});
