import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const directory = resolve(testDirectory, '../composer/input');
const sources = new Map(
    readdirSync(directory)
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => [file, readFileSync(resolve(directory, file), 'utf8')]),
);

test('composer state is declared by its domain owner', () => {
    // These declarations previously lived in unrelated slices of ChatInput.
    // Keep ownership explicit so a later split cannot recreate those cuts.
    const owners = {
        prevWasAbortedRef: 'useComposerControls.ts',
        abortPromptOwnerRef: 'useComposerAbortPrompt.ts',
        canAcceptDropRef: 'useComposerFileDrop.ts',
        referencePicker: 'useComposerReferencePickerState.ts',
        attachmentPreview: 'useComposerAttachmentPreview.ts',
        attachmentCompatibilityRef: 'useComposerAttachmentCompatibility.ts',
        largeTextPasteScopeRef: 'useComposerLargePasteScope.ts',
        composerText: 'useComposerDraftText.ts',
        openAutocomplete: 'useComposerAutocompleteState.ts',
        mobileControlsPanel: 'useComposerMobilePanels.ts',
        promptHistorySearch: 'useComposerHistorySearchState.ts',
        isDragging: 'useComposerDropState.ts',
        largeTextPasteOffer: 'useComposerLargePasteState.ts',
        dictationSendInFlightRef: 'useComposerDictationState.ts',
        handleSubmitRef: 'useComposerSending.ts',
        handleQueueMessageRef: 'useComposerSending.ts',
        sendMessage: 'useComposerSending.ts',
        footerGapClass: 'useComposerControls.ts',
        abortShortcutReaches: 'useComposerControls.ts',
    };
    for (const [name, owner] of Object.entries(owners)) {
        const declaration = new RegExp(`\\bconst (?:\\[)?${name}\\b[^\\n]*=`);
        expect([...sources].filter(([, text]) => declaration.test(text)).map(([file]) => file)).toEqual([owner]);
    }
});

test('outgoing handlers are published by the same owner', () => {
    for (const name of ['handleSubmitRef', 'handleQueueMessageRef']) {
        const assignment = new RegExp(`\\b${name}\\.current =`);
        expect([...sources].filter(([, text]) => assignment.test(text)).map(([file]) => file))
            .toEqual(['useComposerSending.ts']);
    }
    for (const name of ['consumePendingPresetSubmit', 'consumePendingDraftSubmit']) {
        const consume = new RegExp(`\\.${name}\\(`);
        expect([...sources].filter(([, text]) => consume.test(text)).map(([file]) => file))
            .toEqual(['useComposerExternalSubmits.ts']);
    }
});

test('render boundaries receive named domain slices', () => {
    for (const file of ['renderComposerForm.tsx', 'renderComposerDialogs.tsx']) {
        const text = readFileSync(resolve(directory, file), 'utf8');
        expect(text).toContain('type Dependencies = {');
        expect(/^\s+(?:composerText|currentSessionId|setReferencePicker|handleSubmitRef):/m.test(text)).toBe(false);
    }
    const text = readFileSync(resolve(testDirectory, '../ChatInput.tsx'), 'utf8');
    expect(/const \{[\s\S]*?\} = useComposer/.test(text)).toBe(false);
    expect(sources.has('useComposerInputState.ts')).toBe(false);
    expect(sources.has('useComposerEnvironment.ts')).toBe(false);
    expect(sources.get('renderComposerForm.tsx')).not.toContain('<><form');
});

test('moved files keep comments before exports and a final newline', () => {
    for (const [file, text] of sources) {
        expect({ file, newline: text.endsWith('\n') }).toEqual({ file, newline: true });
        expect(/\bexport\s+(?:\/[/*]|\n)/.test(text)).toBe(false);
    }
});
