import { describe, expect, test } from 'bun:test';

import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import {
    CONTEXT_METADATA_KEY,
    contextPayloadFromDraft,
    createContextPart,
    formatContextText,
    readContextPart,
    type ContextPartPayload,
} from './contextParts';

const draft = (overrides: Partial<InlineCommentDraft> = {}): InlineCommentDraft => ({
    id: 'icd-1',
    sessionKey: 's1',
    source: 'diff',
    fileLabel: 'src/app.ts',
    startLine: 3,
    endLine: 5,
    side: 'modified',
    code: 'const x = 1;',
    language: 'ts',
    text: 'fix this',
    createdAt: 1,
    ...overrides,
});

describe('model-facing text', () => {
    test('diff comments keep the pre-metadata wording, including the side', () => {
        expect(formatContextText(contextPayloadFromDraft(draft())))
            .toBe('Comment on `src/app.ts` lines 3-5 (modified):\n```ts\nconst x = 1;\n```\n\nfix this');
    });

    test('file and plan comments omit the side', () => {
        expect(formatContextText(contextPayloadFromDraft(draft({ source: 'file', side: undefined }))))
            .toBe('Comment on `src/app.ts` lines 3-5:\n```ts\nconst x = 1;\n```\n\nfix this');
    });

    test('terminal selections keep the terminal_context envelope', () => {
        const payload = contextPayloadFromDraft(draft({
            source: 'terminal',
            fileLabel: 'Terminal 1',
            terminalId: 'term-1',
            language: '',
            startLine: 12,
            endLine: 13,
            code: 'npm run build\nok',
            text: '',
        }));
        expect(formatContextText(payload)).toBe([
            '<terminal_context>',
            '- Terminal 1 lines 12-13:',
            '  12 | npm run build',
            '  13 | ok',
            '</terminal_context>',
        ].join('\n'));
    });

    test('annotations send the prompt, with user text appended when present', () => {
        const base = draft({ source: 'preview-annotation', fileLabel: 'https://app.dev', code: 'prompt body', text: '' });
        expect(formatContextText(contextPayloadFromDraft(base))).toBe('prompt body');
        expect(formatContextText(contextPayloadFromDraft({ ...base, text: 'also this' })))
            .toBe('prompt body\n\nalso this');
    });

    test('chat quotes send the fragment as a blockquote with the comment below', () => {
        expect(formatContextText(contextPayloadFromDraft(draft({ source: 'chat-quote', fileLabel: 'msg_1', code: 'first line\nsecond line', text: 'why so?' }))))
            .toBe('Comment on this fragment of an earlier message in this conversation:\n> first line\n> second line\n\nwhy so?');
    });

    test('file quotes carry the fragment with an optional line range', () => {
        expect(formatContextText(contextPayloadFromDraft(draft({ source: 'file-quote', fileLabel: 'docs/CHANGELOG.md', startLine: 12, endLine: 13, code: 'a\nb', text: 'why?' }))))
            .toBe('Comment on this fragment of `docs/CHANGELOG.md` lines 12-13:\n> a\n> b\n\nwhy?');
        expect(formatContextText(contextPayloadFromDraft(draft({ source: 'file-quote', fileLabel: 'docs/CHANGELOG.md', startLine: 0, endLine: 0, code: 'a', text: '' }))))
            .toBe('Comment on this fragment of `docs/CHANGELOG.md`:\n> a');
    });

    test('PR comments and checks keep their attachment wording', () => {
        expect(formatContextText(contextPayloadFromDraft(draft({ source: 'pr-comment', fileLabel: 'octo/repo#7', code: 'the comment', text: '' }))))
            .toBe('Attached GitHub PR comment (octo/repo#7):\n\nthe comment');
        expect(formatContextText(contextPayloadFromDraft(draft({ source: 'pr-check', fileLabel: 'CI / build', code: 'boom', text: 'why?' }))))
            .toBe('Attached failed GitHub PR check (CI / build):\n```\nboom\n```\n\nwhy?');
    });
});

describe('round-trip through part metadata', () => {
    const asPart = (payload: ContextPartPayload, text?: string) => ({
        type: 'text',
        ...createContextPart(payload, text),
    });

    test('every draft-based kind survives create → read unchanged', () => {
        const payloads = [
            contextPayloadFromDraft(draft()),
            contextPayloadFromDraft(draft({ source: 'plan', side: undefined })),
            contextPayloadFromDraft(draft({ source: 'terminal', terminalId: 'term-1', language: '' })),
            contextPayloadFromDraft(draft({ source: 'preview-annotation' })),
            contextPayloadFromDraft(draft({ source: 'pr-comment' })),
            contextPayloadFromDraft(draft({ source: 'pr-check' })),
            contextPayloadFromDraft(draft({ source: 'chat-quote', fileLabel: 'msg_1' })),
            contextPayloadFromDraft(draft({ source: 'file-quote', startLine: 3, endLine: 5 })),
            contextPayloadFromDraft(draft({ source: 'file-quote', startLine: 0, endLine: 0 })),
        ];
        for (const payload of payloads) {
            expect(readContextPart(asPart(payload))).toEqual(payload);
        }
    });

    test('github references carry picker-built text and structured identity', () => {
        const payload: ContextPartPayload = { kind: 'github-issue', number: 3, title: 'Bug', url: 'https://x/issues/3' };
        const part = asPart(payload, 'GitHub issue context (JSON)\n{}');
        expect(part.text).toBe('GitHub issue context (JSON)\n{}');
        expect(readContextPart(part)).toEqual(payload);
    });

    test('non-text parts, missing metadata, and malformed payloads read as null', () => {
        expect(readContextPart({ type: 'file', metadata: {} })).toBeNull();
        expect(readContextPart({ type: 'text' })).toBeNull();
        expect(readContextPart({ type: 'text', metadata: { [CONTEXT_METADATA_KEY]: { kind: 'nope' } } })).toBeNull();
        expect(readContextPart({
            type: 'text',
            metadata: { [CONTEXT_METADATA_KEY]: { kind: 'terminal', terminalId: 1, terminalLabel: 'x', startLine: 1, endLine: 1, output: '' } },
        })).toBeNull();
        expect(readContextPart({
            type: 'text',
            metadata: { [CONTEXT_METADATA_KEY]: { kind: 'github-issue', number: 0, title: 't', url: 'u' } },
        })).toBeNull();
    });
});
