import { describe, expect, test } from 'bun:test';

import { takeArrivedComposingDraft } from './useChatViewReveal';

describe('takeArrivedComposingDraft', () => {
    test('a restored composition is recorded without counting as an arrival', () => {
        const seen = new Set<string>();
        takeArrivedComposingDraft({ a: [{ id: 'restored', composing: true }] }, seen);
        expect(takeArrivedComposingDraft({ a: [{ id: 'restored', composing: true }] }, seen)).toBe(false);
    });

    test('a new composition arrives while another one is still composing', () => {
        // A single "any draft composing" flag stays true here, so the second
        // comment never brought the chat forward.
        const seen = new Set<string>();
        takeArrivedComposingDraft({ a: [{ id: 'restored', composing: true }] }, seen);
        expect(takeArrivedComposingDraft({
            a: [{ id: 'restored', composing: true }],
            b: [{ id: 'filed', composing: true }],
        }, seen)).toBe(true);
    });

    test('each composition arrives once, and ordinary drafts never do', () => {
        const seen = new Set<string>();
        expect(takeArrivedComposingDraft({ a: [{ id: 'note' }] }, seen)).toBe(false);
        expect(takeArrivedComposingDraft({ a: [{ id: 'filed', composing: true }] }, seen)).toBe(true);
        expect(takeArrivedComposingDraft({ a: [{ id: 'filed', composing: true }] }, seen)).toBe(false);
    });
});
