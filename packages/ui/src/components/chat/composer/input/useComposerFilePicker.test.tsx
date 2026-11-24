import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { AttachmentPickerInput } from './ComposerAttachmentPickerInput';
import { useComposerFilePicker } from './useComposerFilePicker';

test('a late photo cannot attach to a replacement Chat draft using the same slot', async () => {
    const browser = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const originalDraft = useSessionUIStore.getState().newSessionDraft;
    const originalAttachmentKey = useInputStore.getState().attachmentDraftKey;
    const received: string[] = [];
    const attachFilesWithCitation = async (files: File[]) => { received.push(...files.map((file) => file.name)); };
    const Harness = () => {
        const i18n = useI18n();
        const picker = useComposerFilePicker({ fileIntake: { attachFilesWithCitation }, runtime: { vscodeApi: undefined }, i18n });
        return (
            <>
                <button type="button" onClick={picker.handlePickCameraPhoto}>Take photo</button>
                <AttachmentPickerInput camera ref={picker.cameraInputRef} onChange={picker.handleCameraPhotoSelect} />
            </>
        );
    };

    try {
        useInputStore.setState({ attachmentDraftKey: 'chat-slot' });
        useSessionUIStore.setState({ newSessionDraft: { ...originalDraft, target: 'chat', open: true, draftId: 1 } });
        await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
        const action = host.querySelector('button');
        const input = browser.document.querySelector('input[type=file]');
        if (!action || !(input instanceof browser.HTMLInputElement)) throw new Error('Camera picker is missing');
        const deliver = (name: string) => {
            const files = new browser.FileList();
            files.push(new browser.File(['photo'], name, { type: 'image/jpeg' }));
            input.files = files;
            input.dispatchEvent(new browser.Event('change', { bubbles: true }));
        };
        await act(async () => action.click());
        useSessionUIStore.setState({ newSessionDraft: { ...originalDraft, target: 'chat', open: true, draftId: 2 } });
        await act(async () => deliver('old-draft.jpg'));
        expect(received).toEqual([]);

        await act(async () => action.click());
        await act(async () => deliver('new-draft.jpg'));
        expect(received).toEqual(['new-draft.jpg']);
    } finally {
        await act(async () => root.unmount());
        useSessionUIStore.setState({ newSessionDraft: originalDraft });
        useInputStore.setState({ attachmentDraftKey: originalAttachmentKey });
        await browser.close();
    }
});
