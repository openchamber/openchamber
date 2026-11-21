import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { toast } from '@/components/ui';
import { opencodeClient } from '@/lib/opencode/client';
import { useInputStore, type AddAttachedFileOptions } from '@/sync/input-store';
import { useUIStore } from '@/stores/useUIStore';
import { attachmentsCitedIn } from '@/lib/attachmentIdentity';
import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { LargeTextPasteChoiceAction, LargeTextPasteChoiceKind } from '../ui/LargeTextPasteChoice';
import { useComposerFileIntake } from './useComposerFileIntake';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';

type Offer = { id: number; kind: LargeTextPasteChoiceKind; resolve: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => void; onDismiss?: () => void };
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
    let infoToasts: unknown[];
    let pathReferences: Map<string, string>;
    let reservedNames: Set<string>;
    let sharedCalls: Array<{ name: string; target?: ChatDraftIdentity | null; options?: AddAttachedFileOptions }>;
    let gate: Promise<void> | null;
    let modelInput: string[] | undefined;
    const heldForSend = () => sharedCalls.filter((call) => call.options?.saveOnSend === 'reference').map((call) => call.name);

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
                pendingPastedAttachmentFilenamesRef: { current: reservedNames },
                pendingAttachWorkRef: { current: pendingWork },
            },
            editorActions: { insertTextAtSelection: (text: string) => { draft += text; } },
            selection: { currentModelMetadata: modelInput ? { modalities: { input: modelInput } } : undefined } as never,
            sessionScope: {
                chatDraftIdentity: null,
                attachedFiles: [],
                addAttachedFile: async (file: File, target?: ChatDraftIdentity | null, onAttached?: (files: Array<{ filename: string; agentPath?: string }>) => void, options?: AddAttachedFileOptions) => {
                    if (options) sharedCalls.push({ name: file.name, target, options });
                    if (options && gate) await gate;
                    if (options?.shared) {
                        const landed: AttachedFile = { id: file.name, file, dataUrl: '', mimeType: file.type, filename: file.name, size: file.size, source: 'local' };
                        useInputStore.getState().restoreAttachedFiles([landed], target ?? null);
                    }
                    attached.push(file.name);
                    onAttached?.([{ filename: file.name, agentPath: pathReferences.get(file.name) }]);
                    return true;
                },
            } as never,
            largePasteState: {
                largeTextPasteOfferIdRef: offerIdRef,
                // Like the composer's setter: an offer replaced or cleared without an answer is dismissed.
                setLargeTextPasteOffer: ((next: Offer | null) => {
                    const previous = offer;
                    offer = next;
                    if (previous && previous !== next) previous.onDismiss?.();
                }) as never,
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
        infoToasts = [];
        pathReferences = new Map();
        reservedNames = new Set();
        sharedCalls = [];
        gate = null;
        modelInput = undefined;
        writes = [];
        writeResult = (files) => files.map(({ filename }) => ({ filename, path: `/oc-tmp/openchamber/abc/${filename}` }));
        useInputStore.setState({ attachmentDraftKey: 'draft-a', attachedFiles: [] });
        spies.push(
            spyOn(toast, 'loading').mockImplementation(() => 'saving'),
            spyOn(toast, 'dismiss').mockImplementation(() => 'saving'),
            spyOn(toast, 'info').mockImplementation((message) => { infoToasts.push(message); return 'info'; }),
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
        useUIStore.getState().setSavePastedImagesAsFiles(false);
        windowInstance.close();
    });

    test('Save holds the documents in the draft until Send, writing nothing; other files attach as before', async () => {
        useUIStore.getState().setDocumentAttachBehavior('save');
        pathReferences.set('report.docx', '/Users/me/report.docx');
        await act(async () => { await intake?.attachFilesWithCitation([docx('report.docx'), docx('report.docx'), text('notes.txt')]); });
        expect(attached).toEqual(['report.docx', 'report-2.docx', 'notes.txt']);
        expect(heldForSend()).toEqual(['report.docx', 'report-2.docx']);
        expect(writes).toEqual([]);
        expect(draft).toBe('[report.docx] [report-2.docx] [notes.txt]');
        // A document held as is never claims it could not be converted.
        expect(infoToasts).toEqual([]);
    });

    test('Ask attaches the other files at once and holds the documents until answered', async () => {
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx'), text('notes.txt')]); });
        expect(attached).toEqual(['notes.txt']);
        expect(writes).toEqual([]);
        expect(offer?.kind).toBe('documents');

        // A send started now waits for the document to land in the draft.
        offer?.resolve('attach', true);
        expect(pendingWork.size).toBe(1);
        await settle();
        expect(offer).toBeNull();
        expect(heldForSend()).toEqual(['a.docx']);
        expect(writes).toEqual([]);
        expect(draft).toBe('[notes.txt] [a.docx]');
    });

    test('Ask answered by typing converts the documents and keeps the typed key', async () => {
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx')]); });
        await act(async () => offer?.resolve('inline', true, 'q'));
        await settle();
        expect(writes).toEqual([]);
        expect(attached).toEqual(['a.docx']);
        expect(draft).toBe('q [a.docx]');
    });

    test('a converted document never takes the name of a saved one, so removing its chip cannot leave it cited', async () => {
        useUIStore.getState().setDocumentAttachBehavior('convert');
        draft = '[report.docx](/oc-tmp/openchamber/abc/report.docx) ';
        await act(async () => { await intake?.attachFilesWithCitation([docx('report.docx')]); });
        expect(attached).toEqual(['report-2.docx']);
        expect(attachmentsCitedIn('[report.docx](/oc-tmp/openchamber/abc/report.docx) ', [{ filename: 'report-2.docx' }])).toEqual([]);
    });

    test('Convert keeps the documents on the attachment path', async () => {
        useUIStore.getState().setDocumentAttachBehavior('convert');
        await act(async () => { await intake?.attachFilesWithCitation([docx('a.docx')]); });
        expect(offer).toBeNull();
        expect(writes).toEqual([]);
        expect(attached).toEqual(['a.docx']);
        expect(infoToasts).toEqual([]);
    });

    test('Convert says so when a document reaches the agent as its path instead of text', async () => {
        useUIStore.getState().setDocumentAttachBehavior('convert');
        pathReferences.set('huge.docx', '/Users/me/huge.docx');
        pathReferences.set('notes.txt', '/Users/me/notes.txt');
        await act(async () => { await intake?.attachFilesWithCitation([docx('huge.docx'), text('notes.txt')]); });
        expect(attached).toEqual(['huge.docx', 'notes.txt']);
        expect(infoToasts).toEqual(['chat.fileAttachment.toast.documentAttachedAsPath{"name":"huge.docx"}']);
    });

    describe('with "Save pasted images as files" on', () => {
        const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' });
        const paste = async () => {
            await act(async () => { useUIStore.getState().setSavePastedImagesAsFiles(true); });
            await act(async () => { await intake?.attachFilesWithCitation([png()], 'look'); });
        };

        test('a model that reads images gets the image held with a copy to save at Send; nothing is written now', async () => {
            modelInput = ['text', 'image'];
            await paste();
            expect(sharedCalls).toEqual([{ name: 'image-1.png', target: undefined, options: { saveOnSend: 'copy' } }]);
            expect(writes).toEqual([]);
            expect(draft).toBe('look [image-1.png]');
        });

        test('a model that cannot read images gets the image held to send as its saved path', async () => {
            modelInput = ['text'];
            await paste();
            expect(sharedCalls).toEqual([{ name: 'image-1.png', target: undefined, options: { saveOnSend: 'reference' } }]);
            expect(writes).toEqual([]);
            expect(draft).toBe('look [image-1.png]');
        });

        test('with the setting off the image attaches as an image', async () => {
            await act(async () => { await intake?.attachFilesWithCitation([png()], 'look'); });
            expect(sharedCalls).toEqual([]);
            expect(attached).toEqual(['image-1.png']);
            expect(writes).toEqual([]);
        });
    });

    describe('a share from another app', () => {
        const target = { runtimeKey: 'runtime', directory: '/repo', sessionId: 'draft:share' };
        const targetKey = getChatDraftIdentityKey(target);
        let away: string[];
        let awayTargets: ChatDraftIdentity[];
        const share = (files: File[], leadingText = '') => intake!.attachSharedFiles(files, {
            leadingText, target, writeAway: (to, value) => { away.push(value); awayTargets.push(to); },
        });

        beforeEach(() => {
            away = [];
            awayTargets = [];
            useInputStore.setState({ attachmentDraftKey: targetKey, attachmentDrafts: new Map() });
        });

        test('attaches into its own draft without writing anything on a server', async () => {
            let refused: unknown;
            await act(async () => { refused = await share([text('notes.txt')], 'Look at this'); });
            expect(refused).toEqual([]);
            expect(sharedCalls).toEqual([{ name: 'notes.txt', target, options: { shared: true } }]);
            expect(writes).toEqual([]);
            expect(draft).toBe('Look at this [notes.txt]');
            expect(away).toEqual([]);
            expect([...reservedNames]).toEqual([]);
        });

        test('left mid-read, its text and citations go to its own draft, never the one on screen', async () => {
            gate = Promise.resolve().then(() => { useInputStore.setState({ attachmentDraftKey: 'other-draft' }); });
            draft = 'my other draft';
            await act(async () => { await share([text('notes.txt')], 'Look at this'); });
            expect(attached).toEqual(['notes.txt']);
            expect(draft).toBe('my other draft');
            expect(away).toEqual(['Look at this [notes.txt]']);
        });

        test('a paste while the share is reading cannot take one of its names', async () => {
            let release = () => {};
            gate = new Promise((resolve) => { release = resolve; });
            let sharing: Promise<unknown> = Promise.resolve();
            await act(async () => { sharing = share([text('notes.txt')]); });
            await act(async () => { await intake?.attachFilesWithCitation([text('notes.txt')]); });
            release();
            await act(async () => { await sharing; });
            expect(attached.sort()).toEqual(['notes-2.txt', 'notes.txt']);
        });

        test('Office documents get the same choice, and "as is" keeps the original until Send', async () => {
            let sharing: Promise<unknown> = Promise.resolve();
            await act(async () => { sharing = share([docx('plan.docx'), text('notes.txt')]); });
            expect(offer?.kind).toBe('documents');
            await act(async () => offer?.resolve('attach', true));
            await act(async () => { await sharing; });
            expect(heldForSend()).toEqual(['plan.docx']);
            expect(attached).toEqual(['notes.txt', 'plan.docx']);
            expect(writes).toEqual([]);
            expect(draft).toBe('[notes.txt] [plan.docx]');
        });

        test('converting an Office document stays local too', async () => {
            let sharing: Promise<unknown> = Promise.resolve();
            await act(async () => { sharing = share([docx('plan.docx')]); });
            await act(async () => offer?.resolve('inline', true));
            await act(async () => { await sharing; });
            expect(sharedCalls.map((call) => call.name)).toEqual(['plan.docx']);
            expect(heldForSend()).toEqual([]);
            expect(writes).toEqual([]);
        });

        test('leaving the draft before choosing keeps the originals there, uploaded at Send at the earliest', async () => {
            let sharing: Promise<unknown> = Promise.resolve();
            await act(async () => { sharing = share([docx('plan.docx')]); });
            expect(offer?.kind).toBe('documents');
            await act(async () => { useInputStore.setState({ attachmentDraftKey: 'other-draft' }); });
            await act(async () => { await sharing; });
            expect(heldForSend()).toEqual(['plan.docx']);
            expect(writes).toEqual([]);
            expect(away).toEqual(['[plan.docx]']);
        });

        test('a newer offer that replaces the Office choice settles it, so Send waits for nothing it cannot finish', async () => {
            let sharing: Promise<unknown> = Promise.resolve();
            await act(async () => { sharing = share([docx('plan.docx')]); });
            const choice = offer;
            await act(async () => { void intake?.attachFilesWithCitation([docx('other.docx')]); });
            expect(offer).not.toBe(choice);
            await act(async () => { await sharing; });
            await settle();
            expect(heldForSend()).toEqual(['plan.docx']);
            expect(writes).toEqual([]);
            expect(pendingWork.size).toBe(0);
        });

        test('a destination changed mid-read takes the late file and its citation along', async () => {
            const ui = useSessionUIStore.getState();
            const before = ui.newSessionDraft;
            const moved = { runtimeKey: 'runtime', directory: '/elsewhere', sessionId: 'draft:share' };
            useSessionUIStore.setState({ newSessionDraft: { ...before, open: true, target: 'project', workDraftId: 'share', directoryOverride: '/repo', bootstrapPendingDirectory: null } });
            gate = Promise.resolve().then(() => {
                useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, directoryOverride: '/elsewhere' } });
                useInputStore.setState({ attachmentDraftKey: 'other-draft' });
            });
            try {
                await act(async () => { await share([text('notes.txt')], 'Look at this'); });
                expect(useInputStore.getState().getAttachedFiles(moved).map((file) => file.filename)).toEqual(['notes.txt']);
                expect(useInputStore.getState().getAttachedFiles(target)).toEqual([]);
                expect(away).toEqual(['Look at this [notes.txt]']);
                expect(awayTargets).toEqual([moved]);
            } finally {
                useSessionUIStore.setState({ newSessionDraft: before });
            }
        });

        test('the "Save" setting keeps the original until Send without asking', async () => {
            useUIStore.getState().setDocumentAttachBehavior('save');
            await act(async () => { await share([docx('plan.docx')]); });
            expect(offer).toBeNull();
            expect(heldForSend()).toEqual(['plan.docx']);
            expect(writes).toEqual([]);
        });
    });
});
