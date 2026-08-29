import { afterEach, describe, expect, test } from 'bun:test';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { ContextPart } from '@/lib/messages/contextParts';
import { restoreComposerPayload } from './restoreComposerPayload';

const target = { directory: '/repo', sessionKey: 'session-1' };
const draft = {
    source: 'file' as const,
    fileLabel: 'app.ts',
    startLine: 4,
    endLine: 4,
    code: 'newer draft',
    language: 'ts',
    text: 'unrelated',
};

describe('restoreComposerPayload', () => {
    afterEach(() => { useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} }); });

    test('replaces newer inline drafts while preserving queued context and attachments', () => {
        useInlineCommentDraftStore.getState().addDraft(target, draft);
        const attachments: AttachedFile[] = [{
            id: 'restored-file',
            file: new File([], 'restored.txt'),
            dataUrl: 'https://example.test/restored.txt',
            mimeType: 'text/plain',
            filename: 'restored.txt',
            size: 10,
            source: 'local' as const,
        }];
        const contextParts: ContextPart[] = [{
            text: 'queued context',
            synthetic: true,
            metadata: { openchamberContext: {
                kind: 'file-quote', fileLabel: 'queued.ts', quote: 'queued', text: '',
            } },
        }];
        const state: { message: string; attachments: AttachedFile[]; pending: ContextPart[] | null } = { message: '', attachments: [], pending: null };

        restoreComposerPayload(target, { content: 'queued message', attachments, contextParts }, {
            clearInlineDrafts: (draftTarget) => { useInlineCommentDraftStore.getState().clearDrafts(draftTarget); },
            setMessage: (content) => { state.message = content; },
            setAttachedFiles: (next) => { state.attachments = next; },
            setPendingSyntheticParts: (next) => { state.pending = next; },
        });

        expect(useInlineCommentDraftStore.getState().getDrafts(target)).toEqual([]);
        expect(state).toEqual({ message: 'queued message', attachments, pending: contextParts });
    });
});
