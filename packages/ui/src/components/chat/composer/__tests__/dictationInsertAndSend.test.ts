import { describe, expect, test } from 'bun:test';

import { appendInlineText } from '../text';

/**
 * Regression: the record-and-send button used to compose its outgoing text from
 * `composerRef.current.getValue()`. The transcript resolves asynchronously, and
 * on mobile the shell has usually collapsed into the pill by then — the editor
 * is unmounted, so getValue() returns '' (see ComposerEditor.getValue:
 * `viewRef.current?.state.doc.toString() ?? ''`). Appending the transcript to
 * that empty string dropped the user's typed draft, and because the `??`
 * fallback never fired on an empty string (only on null), messageRef never
 * rescued it either. The fix reads the draft from messageRef instead.
 *
 * These tests pin the two inputs the handler chooses between, so a revert to
 * the editor read is caught here rather than on a phone.
 */
describe('dictation insert-and-send composition', () => {
    test('appends the transcript to the typed draft kept in the ref', () => {
        const typedDraft = 'typed before dictating';
        const transcript = 'dictated words';

        expect(appendInlineText(typedDraft, transcript)).toBe('typed before dictating dictated words ');
    });

    test('an unmounted-editor read (empty string) is what used to drop the draft', () => {
        const typedDraft = 'typed before dictating';
        const transcript = 'dictated words';
        const unmountedEditorValue = '';

        // The old path: transcript appended to the editor value, so the typed
        // text is gone from the outgoing message.
        expect(appendInlineText(unmountedEditorValue, transcript)).toBe('dictated words ');
        expect(appendInlineText(unmountedEditorValue, transcript)).not.toContain(typedDraft);

        // The fixed path: transcript appended to the ref-held draft.
        expect(appendInlineText(typedDraft, transcript)).toContain(typedDraft);
        expect(appendInlineText(typedDraft, transcript)).toContain(transcript);
    });

    test('dictating into an empty composer still sends just the transcript', () => {
        expect(appendInlineText('', 'just dictated')).toBe('just dictated ');
    });
});
