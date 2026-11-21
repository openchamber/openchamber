import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import { useInputStore } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { MAX_ATTACHMENT_BYTES } from '@/sync/input-store';
import { attachmentsCitedIn } from '@/lib/attachmentIdentity';
import { findLocalFileLinks } from '../../attachmentCitations';
import type { LargeTextPasteChoiceAction, LargeTextPasteChoiceKind } from '../ui/LargeTextPasteChoice';
import { useComposerFileIntake } from './useComposerFileIntake';

type Offer = { id: number; kind: LargeTextPasteChoiceKind; resolve: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => void };
type Intake = ReturnType<typeof useComposerFileIntake>;

const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

describe('useComposerFileIntake with office documents', () => {
    let windowInstance: Window;
    let root: Root;
    let draft: string;
    let intake: Intake | null;
    let offer: Offer | null;
    let pendingWork: Set<Promise<void>>;
    let attached: string[];
    let writes: Array<{ directory: string | null | undefined; current?: boolean; files: Array<{ filename: string; bytes: number[] }> }>;
    let writeResult: (files: ReadonlyArray<{ filename: string }>) => Array<{ filename: string; path: string } | { filename: string; error: Error }>;
    const spies: Array<{ mockRestore: () => void }> = [];
    let errorToasts: unknown[][];

    const editor = {
        getValue: () => draft,
        getSelection: () => ({ start: draft.length, end: draft.length }),
        replaceRange: (from: number, to: number, text: string) => { draft = draft.slice(0, from) + text + draft.slice(to); },
        focus: () => undefined,
    };

    const Harness = () => {
        const offerIdRef = React.useRef(0);
        // SAFETY: the hook reads only the members these fakes provide; the rest of each dependency is never touched.
        const dependencies: Parameters<typeof useComposerFileIntake>[0] = {
            editorState: { composerRef: { current: editor } } as never,
            draftText: { composerText: { get: () => draft } } as never,
            i18n: { t: ((key: string, vars?: Record<string, string>) => `${key}${vars ? JSON.stringify(vars) : ''}`) as never },
            attachmentWork: {
                pendingPastedAttachmentFilenamesRef: { current: new Set<string>() },
                pendingAttachWorkRef: { current: pendingWork },
            },
            editorActions: { insertTextAtSelection: (text: string) => { draft += text; } },
            selection: { currentModelMetadata: undefined, currentModelId: 'm', currentProviderId: 'p' } as never,
            sessionScope: {
                currentDirectory: '/repo',
                chatDraftIdentity: null,
                attachedFiles: [],
                addAttachedFile: async (file: File, _target?: null, onAttached?: (files: Array<{ filename: string }>) => void) => {
                    attached.push(file.name);
                    onAttached?.([{ filename: file.name }]);
                    return true;
                },
            } as never,
            largePasteState: {
                largeTextPasteOfferIdRef: offerIdRef,
                setLargeTextPasteOffer: ((next: Offer | null) => { offer = next; }) as never,
            },
            mobileShell: { mobileShell: { expanded: true, expand: () => undefined } as never },
        };
        intake = useComposerFileIntake(dependencies);
        return null;
    };

    const docx = (name: string) => new File([DOCX], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const text = (name: string) => new File(['notes'], name, { type: 'text/plain' });
    const settle = async () => { await act(async () => { await Promise.allSettled([...pendingWork]); }); };

    beforeEach(async () => {
        windowInstance = new Window({ url: 'http://localhost' });
        Object.assign(globalThis, { window: windowInstance, document: windowInstance.document, navigator: windowInstance.navigator, IS_REACT_ACT_ENVIRONMENT: true });
        draft = '';
        intake = null;
        offer = null;
        pendingWork = new Set();
        attached = [];
        errorToasts = [];
        writes = [];
        writeResult = (files) => files.map(({ filename }) => ({ filename, path: `/oc-tmp/openchamber/abc/${filename}` }));
        useInputStore.setState({ attachmentDraftKey: 'draft-a', attachedFiles: [] });
        spies.push(
            spyOn(toast, 'loading').mockImplementation(() => 'saving'),
            spyOn(toast, 'dismiss').mockImplementation(() => 'saving'),
            spyOn(toast, 'info').mockImplementation(() => 'info'),
            spyOn(toast, 'error').mockImplementation((message) => { errorToasts.push([message]); return 'error'; }),
            spyOn(opencodeClient, 'writeOpenCodeTempFiles').mockImplementation(async (directory, files, options) => {
                const read = [];
                for (const { filename, bytes } of files) read.push({ filename, bytes: Array.from(bytes instanceof Uint8Array ? bytes : await bytes()) });
                writes.push({ directory, current: options?.isCurrentRuntime?.(), files: read });
                return writeResult(files);
            }),
        );
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(<Harness />));
    });

    afterEach(async () => {
        for (const spy of spies.splice(0)) spy.mockRestore();
        useUIStore.getState().setDocumentAttachBehavior('ask');
        await act(async () => root.unmount());
        windowInstance.close();
    });

    test('Save writes the original bytes where OpenCode runs and links them; other files attach as before', async () => {
        useUIStore.getState().setDocumentAttachBehavior('save');
        await act(async () => { await intake?.attachFilesWithCitation([docx('report.docx'), docx('report.docx'), text('notes.txt')]); });
        expect(attached).toEqual(['notes.txt']);
        expect(writes).toEqual([{ directory: '/repo', current: true, files: [
            { filename: 'report.docx', bytes: Array.from(DOCX) },
            { filename: 'report-2.docx', bytes: Array.from(DOCX) },
        ] }]);
        expect(draft).toBe('[notes.txt] [report.docx](/oc-tmp/openchamber/abc/report.docx) [report-2.docx](/oc-tmp/openchamber/abc/report-2.docx)');
    });

    test('Ask attaches the other files at once and holds the documents until answered', async () => {
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx'), text('notes.txt')]); });
        expect(attached).toEqual(['notes.txt']);
        expect(writes).toEqual([]);
        expect(offer?.kind).toBe('documents');

        // A send started now waits for the save.
        offer?.resolve('attach', true);
        expect(pendingWork.size).toBe(1);
        await settle();
        expect(offer).toBeNull();
        expect(writes.map((write) => write.files.map((file) => file.filename))).toEqual([['a.docx']]);
        expect(draft).toBe('[notes.txt] [a.docx](/oc-tmp/openchamber/abc/a.docx)');
    });

    test('Ask answered by typing converts the documents and keeps the typed key', async () => {
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx')]); });
        await act(async () => offer?.resolve('inline', true, 'q'));
        await settle();
        expect(writes).toEqual([]);
        expect(attached).toEqual(['a.docx']);
        expect(draft).toBe('q [a.docx]');
    });

    test('a refused write names the file, leaves no link and does not convert it', async () => {
        useUIStore.getState().setDocumentAttachBehavior('save');
        writeResult = (files) => files.map(({ filename }) => filename === 'b.docx'
            ? { filename, error: new Error('refused') }
            : { filename, path: `/oc-tmp/${filename}` });
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx'), docx('b.docx')]); });
        expect(draft).toBe('[a.docx](/oc-tmp/a.docx)');
        expect(attached).toEqual([]);
        expect(errorToasts).toEqual([['chat.chatInput.toast.imageCopySaveFailed{"files":"b.docx"}']]);
    });

    test('a save that finishes after the draft changed lands nowhere', async () => {
        useUIStore.getState().setDocumentAttachBehavior('save');
        writeResult = (files) => {
            useInputStore.setState({ attachmentDraftKey: 'draft-b' });
            return files.map(({ filename }) => ({ filename, path: `/oc-tmp/${filename}` }));
        };
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx')]); });
        expect(writes).toHaveLength(1);
        expect(draft).toBe('');
    });

    test('a save that finishes after switching away from the runtime and back lands nowhere', async () => {
        useUIStore.getState().setDocumentAttachBehavior('save');
        const before = getRuntimeKey();
        // switchRuntimeEndpoint dispatches on the happy-dom window, which takes only its own events.
        const previousCustomEvent = globalThis.CustomEvent;
        Object.assign(globalThis, { CustomEvent: windowInstance.CustomEvent });
        writeResult = (files) => {
            switchRuntimeEndpoint({ apiBaseUrl: 'https://second.test', runtimeKey: `${before}-second` });
            switchRuntimeEndpoint({ apiBaseUrl: 'https://first.test', runtimeKey: before });
            return files.map(({ filename }) => ({ filename, path: `/oc-tmp/${filename}` }));
        };
        try {
            await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx')]); });
            expect(writes).toHaveLength(1);
            expect(draft).toBe('');
            expect(errorToasts).toEqual([]);
        } finally {
            switchRuntimeEndpoint({ apiBaseUrl: 'https://first.test', runtimeKey: before });
            Object.assign(globalThis, { CustomEvent: previousCustomEvent });
        }
    });

    test('a document over the send limit is named and skipped while the rest still save', async () => {
        useUIStore.getState().setDocumentAttachBehavior('save');
        const big = docx('big.docx');
        Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 });
        await act(async () => { await intake?.attachFilesWithCitation([big, docx('small.docx')]); });
        expect(writes.map((write) => write.files.map((file) => file.filename))).toEqual([['small.docx']]);
        expect(draft).toBe('[small.docx](/oc-tmp/openchamber/abc/small.docx)');
        expect(errorToasts).toEqual([['chat.fileAttachment.toast.overSendLimit{"name":"big.docx","size":"20.0 MB"}']]);
    });

    test('a converted document never takes the name of a saved one, so removing its chip cannot leave it cited', async () => {
        useUIStore.getState().setDocumentAttachBehavior('convert');
        draft = '[report.docx](/oc-tmp/openchamber/abc/report.docx) ';
        await act(async () => { await intake?.attachFilesWithCitation([docx('report.docx')]); });
        expect(attached).toEqual(['report-2.docx']);
        expect(attachmentsCitedIn('[report.docx](/oc-tmp/openchamber/abc/report.docx) ', [{ filename: 'report-2.docx' }])).toEqual([]);
    });

    test('a saved document whose name has angle brackets still links as a local file', async () => {
        useUIStore.getState().setDocumentAttachBehavior('save');
        await act(async () => { await intake?.attachFilesWithCitation([docx('Budget > draft.docx')]); });
        expect(findLocalFileLinks(draft)).toEqual([{
            start: 0, end: draft.length, name: 'Budget _ draft.docx', path: '/oc-tmp/openchamber/abc/Budget _ draft.docx',
        }]);
    });

    test('Convert keeps the documents on the attachment path', async () => {
        useUIStore.getState().setDocumentAttachBehavior('convert');
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx')]); });
        expect(offer).toBeNull();
        expect(writes).toEqual([]);
        expect(attached).toEqual(['a.docx']);
    });
});
