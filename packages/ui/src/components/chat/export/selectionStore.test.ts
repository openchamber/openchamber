import { describe, expect, test } from 'bun:test';
import { conversationSelectionKey, createConversationSelectionStore } from './selectionStore';

describe('conversation selection store', () => {
    test('starts inactive and begin selects exactly one message', () => {
        const store = createConversationSelectionStore();
        expect(store.getState().active).toBe(false);
        expect([...store.getState().selected]).toEqual([]);
        store.getState().begin('user:first');
        expect(store.getState().active).toBe(true);
        expect([...store.getState().selected]).toEqual(['user:first']);
        store.getState().toggle('assistant:first');
        store.getState().begin('user:second');
        expect([...store.getState().selected]).toEqual(['user:second']);
    });

    test('inactive toggle is a no-op and cancel clears all selection', () => {
        const store = createConversationSelectionStore();
        const initial = store.getState();
        store.getState().toggle('user:first');
        expect(store.getState()).toBe(initial);
        store.getState().begin('user:first');
        store.getState().toggle('assistant:first');
        expect([...store.getState().selected]).toEqual(['user:first', 'assistant:first']);
        store.getState().toggle('user:first');
        expect([...store.getState().selected]).toEqual(['assistant:first']);
        store.getState().toggle('assistant:first');
        expect(store.getState().active).toBe(true);
        expect(store.getState().selected.size).toBe(0);
        store.getState().begin('user:second');
        store.getState().cancel();
        expect(store.getState().active).toBe(false);
        expect(store.getState().selected.size).toBe(0);
        const cancelled = store.getState();
        store.getState().toggle('user:second');
        expect(store.getState()).toBe(cancelled);
    });

    test('separate chat columns own independent stores', () => {
        const left = createConversationSelectionStore();
        const right = createConversationSelectionStore();
        left.getState().begin('user:same');
        expect(right.getState().active).toBe(false);
        right.getState().begin('assistant:same');
        left.getState().toggle('assistant:same');
        right.getState().cancel();
        expect([...left.getState().selected]).toEqual(['user:same', 'assistant:same']);
        expect(left.getState().active).toBe(true);
        expect(right.getState().selected.size).toBe(0);
    });

    test('user and assistant keys remain distinct for the same turn id', () => {
        expect(conversationSelectionKey('user', 'turn')).toBe('user:turn');
        expect(conversationSelectionKey('assistant', 'turn')).toBe('assistant:turn');
    });
});
