import { describe, expect, test } from 'bun:test';
import type { FilePart } from '@/lib/opencode/model';
import {
    collectOpenableAttachmentNames,
    decodeDataUrlText,
    findAttachmentPart,
    getIssueLinkKind,
    getTrackerItemLinkProvider,
    isOpenableAttachmentName,
    isTextLikeFile,
    resolveAttachmentOpenTarget,
    trackerItemLinkMime,
} from './attachmentPreview';

const file = (over: Partial<FilePart> = {}): FilePart => ({
    id: 'file-1',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'file',
    mime: 'text/plain',
    filename: 'pasted-context-1.txt',
    url: `data:text/plain;base64,${Buffer.from('hello pasted text').toString('base64')}`,
    ...over,
});

describe('what opening a sent attachment does', () => {
    test('a pasted text opens its decoded text in the content dialog', () => {
        const pasted = file();
        const target = resolveAttachmentOpenTarget(pasted, [pasted]);
        expect(target?.kind).toBe('popup');
        if (target?.kind !== 'popup') return;
        expect(target.popup.title).toBe('pasted-context-1.txt');
        expect(target.popup.content).toBe('hello pasted text');
        expect(target.popup.language).toBe('text');
        expect(target.popup.image).toBeUndefined();
    });

    test('a picked JSON file decodes as text too', () => {
        const json = file({ mime: 'application/json', filename: 'data.json', url: `data:application/json;base64,${Buffer.from('{"k":1}').toString('base64')}` });
        const target = resolveAttachmentOpenTarget(json, [json]);
        expect(target?.kind === 'popup' && target.popup.content).toBe('{"k":1}');
    });

    test('an image opens the viewer on its own place in the message gallery', () => {
        const first = file({ mime: 'image/png', filename: 'image-1.png', url: 'data:image/png;base64,aa' });
        const second = file({ mime: 'image/png', filename: 'dir/image-2.png', url: 'data:image/png;base64,bb' });
        const target = resolveAttachmentOpenTarget(second, [first, file(), second]);
        expect(target?.kind).toBe('popup');
        if (target?.kind !== 'popup') return;
        expect(target.popup.title).toBe('image-2.png');
        expect(target.popup.image?.url).toBe(second.url);
        expect(target.popup.image?.gallery?.map((entry) => entry.filename)).toEqual(['image-1.png', 'image-2.png']);
        expect(target.popup.image?.index).toBe(1);
    });

    test('a file attached by path opens that file, wherever its bytes were sent', () => {
        const byPath = file({ filename: 'notes.md', url: 'file:///Users/me/project/docs/my%20notes.md' });
        expect(resolveAttachmentOpenTarget(byPath, [byPath])).toEqual({ kind: 'file', path: '/Users/me/project/docs/my notes.md' });

        const lineRange = file({ filename: 'a.ts', url: 'file:///repo/src/a.ts?start=3&end=9' });
        expect(resolveAttachmentOpenTarget(lineRange, [lineRange])).toEqual({ kind: 'file', path: '/repo/src/a.ts' });

        const windows = file({ filename: 'b.ts', url: 'file:///C:/repo/b.ts' });
        expect(resolveAttachmentOpenTarget(windows, [windows])).toEqual({ kind: 'file', path: 'C:/repo/b.ts' });

        const image = file({ mime: 'image/png', filename: 'shot.png', url: 'file:///repo/shot.png' });
        expect(resolveAttachmentOpenTarget(image, [image])).toEqual({ kind: 'file', path: '/repo/shot.png' });
    });

    test('a by-path image stays out of the gallery of inline images', () => {
        const inline = file({ mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,aa' });
        const byPath = file({ mime: 'image/png', filename: 'b.png', url: 'file:///repo/b.png' });
        const target = resolveAttachmentOpenTarget(inline, [inline, byPath]);
        expect(target?.kind === 'popup' && target.popup.image?.gallery?.map((entry) => entry.url)).toEqual([inline.url]);
    });

    test('an issue reference opens its page', () => {
        const issue = file({ mime: 'application/vnd.github.issue-link', filename: 'issue-1', url: 'https://github.com/o/r/issues/1' });
        expect(resolveAttachmentOpenTarget(issue, [issue])).toEqual({ kind: 'external', url: issue.url });
    });

    test('a tracker item link names its tracker; a Linear link from before trackers reads as Linear', () => {
        expect(getTrackerItemLinkProvider({ mime: trackerItemLinkMime('linear') })).toBe('linear');
        expect(getTrackerItemLinkProvider({ mime: 'application/vnd.openchamber.linear-issue-link' })).toBe('linear');
        expect(getTrackerItemLinkProvider({ mime: 'application/vnd.github.issue-link' })).toBeNull();
        expect(getIssueLinkKind({ mime: 'application/vnd.openchamber.linear-issue-link' })).toBe('tracker-item');
        const item = file({ mime: trackerItemLinkMime('linear'), filename: 'ENG-1: Login', url: 'https://linear.app/x/issue/ENG-1' });
        expect(resolveAttachmentOpenTarget(item, [item])).toEqual({ kind: 'external', url: item.url });
    });

    test('nothing opens for what the app cannot show', () => {
        const pdf = file({ mime: 'application/pdf', filename: 'spec.pdf', url: 'data:application/pdf;base64,JVBERg==' });
        const folder = file({ mime: 'application/x-directory', filename: 'src', url: 'file:///repo/src' });
        const remoteText = file({ url: 'https://example.com/notes.txt' });
        expect(resolveAttachmentOpenTarget(pdf, [pdf])).toBeNull();
        expect(resolveAttachmentOpenTarget(folder, [folder])).toBeNull();
        expect(resolveAttachmentOpenTarget(remoteText, [remoteText])).toBeNull();
        expect(resolveAttachmentOpenTarget(file({ url: '' }), [])).toBeNull();
        expect(resolveAttachmentOpenTarget(undefined, [])).toBeNull();
    });
});

describe('matching a citation to its attachment', () => {
    for (const filename of ['/Users/me/Documents/report.txt', 'C:\\Users\\me\\report.txt', '/Users/me/Documents/photo.heic', '/home/me/weird\\name.txt']) {
        test(`opens a basename citation for the sent path ${filename}`, () => {
            const name = filename.startsWith('C:') ? 'report.txt' : filename.slice(filename.lastIndexOf('/') + 1);
            const sent = file({ filename, mime: filename.endsWith('.heic') ? 'image/jpeg' : 'text/plain' });
            const openable = collectOpenableAttachmentNames([sent]);

            expect(isOpenableAttachmentName(openable, name)).toBe(true);
            expect(findAttachmentPart(name, [sent])).toBe(sent);
            expect(resolveAttachmentOpenTarget(findAttachmentPart(name, [sent]), [sent])?.kind).toBe('popup');
            expect(sent.filename).toBe(filename);
        });
    }

    test('finds the file a citation names, ignoring case and spaces like citations do', () => {
        const pasted = file();
        expect(findAttachmentPart('  Pasted-Context-1.TXT ', [pasted])).toBe(pasted);
        expect(findAttachmentPart('other.txt', [pasted])).toBeUndefined();
        expect(findAttachmentPart(null, [pasted])).toBeUndefined();
    });

    test('lists only the names whose chips open something', () => {
        const pasted = file();
        const pdf = file({ mime: 'application/pdf', filename: 'spec.pdf', url: 'data:application/pdf;base64,JVBERg==' });
        const openable = collectOpenableAttachmentNames([pasted, pdf]);
        expect(isOpenableAttachmentName(openable, 'PASTED-CONTEXT-1.txt')).toBe(true);
        expect(isOpenableAttachmentName(openable, 'spec.pdf')).toBe(false);
    });

    test('the text test and the data URL decoder keep their contracts', () => {
        expect(isTextLikeFile({ mime: 'text/plain' })).toBe(true);
        expect(isTextLikeFile({ mime: 'application/json' })).toBe(true);
        expect(isTextLikeFile({ mime: 'image/png' })).toBe(false);
        expect(decodeDataUrlText('data:text/plain;base64,aGk=')).toBe('hi');
        expect(decodeDataUrlText('https://example.com/x.txt')).toBeNull();
    });
});
