import { describe, expect, test } from 'bun:test';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { getAttachmentsToRestore } from '../attachmentRecovery';
import { buildOutgoingMessage, type OutgoingMessageInput } from '../buildOutgoingMessage';

const attachment = (id: string): AttachedFile => ({
    id, filename: `${id}.txt`, file: new File(['content'], `${id}.txt`),
    mimeType: 'text/plain', size: 7, dataUrl: `file:///repo/${id}.txt`, source: 'server', serverPath: `/repo/${id}.txt`,
});
const sanitize = (files: readonly AttachedFile[]): AttachedFile[] => files.map((file) => ({ ...file, dataUrl: `file://${file.serverPath}` }));
const build = (input: OutgoingMessageInput, derived: AttachedFile[] = []) => buildOutgoingMessage(input, {
    parseAgentMention: (text) => ({ text }), extractFileMentions: (text) => ({ text, attachments: derived }),
    sanitizeAttachments: (files) => sanitize(files ?? []), collectSkillNames: () => [],
});

describe('submission attachment recovery', () => {
    test('does not promote text-derived files, including converted documents and images', () => {
        const derived = [attachment('inline'), attachment('converted-document'), attachment('converted-image')];
        expect(getAttachmentsToRestore([], derived, [], sanitize)).toEqual([]);
    });

    test('keeps original order, normalizes retained originals, and preserves context attachments', () => {
        const queued = attachment('queued');
        const picked = attachment('picked');
        const filtered = attachment('filtered');
        const context = attachment('context');
        expect(getAttachmentsToRestore([queued, picked, filtered], [picked, attachment('derived'), queued], [context], sanitize))
            .toEqual([...sanitize([queued, picked]), context]);
    });

    test('does not mutate source arrays or original attachment objects', () => {
        const original = attachment('picked');
        original.dataUrl = 'old-url';
        const inputs = Object.freeze([Object.freeze(original)]);
        const recovered = getAttachmentsToRestore(inputs, inputs, [], sanitize);
        expect(inputs[0].dataUrl).toBe('old-url');
        expect(recovered[0].dataUrl).toBe('file:///repo/picked.txt');
        expect(recovered[0]).not.toBe(original);
    });

    for (const composerText of [null, '@missing'] as const) {
        test(`queue send preserves only consumed originals, composerText=${composerText}`, () => {
            const queued = attachment('queued');
            const picked = attachment('picked');
            const input: OutgoingMessageInput = {
                queued: [{ text: 'queued', attachments: [queued] }], composerText, composerAttachments: [picked],
                inlineComments: [], syntheticTexts: [], references: [],
            };
            const original = [...input.queued.flatMap((item) => item.attachments ?? []), ...(composerText !== null ? input.composerAttachments : [])];
            const outgoing = build(input, composerText !== null ? [attachment('derived')] : []);
            const recovered = getAttachmentsToRestore(original, outgoing.primaryAttachments, [], sanitize);
            expect(recovered.map((file) => file.id)).toEqual(composerText === null ? ['queued'] : ['queued', 'picked']);
            const retry = build({ ...input, queued: [], composerText: 'hello', composerAttachments: recovered });
            expect(retry.primaryAttachments.map((file) => file.id)).toEqual(recovered.map((file) => file.id));
            expect(retry.primaryText).toBe('hello');
        });
    }

    test('retaining mention text rebuilds its attachment without adding it to the draft', () => {
        const input: OutgoingMessageInput = {
            queued: [], composerText: '@missing', composerAttachments: [], inlineComments: [], syntheticTexts: [], references: [],
        };
        const first = build(input, [attachment('first-derived')]);
        const recovered = getAttachmentsToRestore([], first.primaryAttachments, [], sanitize);
        const retry = build({ ...input, composerAttachments: recovered }, [attachment('retry-derived')]);
        expect(recovered).toEqual([]);
        expect(retry.primaryAttachments.map((file) => file.id)).toEqual(['retry-derived']);
        expect(getAttachmentsToRestore([], retry.primaryAttachments, [], sanitize)).toEqual([]);
        expect(build({ ...input, composerText: 'hello', composerAttachments: recovered }).primaryAttachments).toEqual([]);
    });
});
