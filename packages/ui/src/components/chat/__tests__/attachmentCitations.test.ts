import { describe, expect, test } from 'bun:test';

import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    findAttachmentCitationRanges,
    findImagePathCitationNames,
    findLocalFileLinks,
    imageSaveModeForModel,
    isGenericImageFilename,
    nextPastedContextFilename,
} from '../attachmentCitations';


describe('attachment citations', () => {
    test('keeps meaningful image names', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'desktop_without_icons.jpg', type: 'image/jpeg' },
        ], [])).toEqual(['desktop_without_icons.jpg']);
    });

    test('renames generic clipboard image names', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'image.png', type: 'image/png' },
            { name: 'Screenshot.png', type: 'image/png' },
        ], [])).toEqual(['image-1.png', 'image-2.png']);
    });

    test('deduplicates meaningful names inside pending attachments', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'desktop.jpg', type: 'image/jpeg' },
            { name: 'desktop.jpg', type: 'image/jpeg' },
        ], ['desktop-2.jpg'])).toEqual(['desktop.jpg', 'desktop-3.jpg']);
    });

    test('continues generated image indexes from existing pending attachments', () => {
        expect(assignImageAttachmentFilenames([
            { name: 'image.png', type: 'image/png' },
            { name: '', type: 'image/webp' },
        ], ['image-1.png'])).toEqual(['image-2.png', 'image-3.webp']);
    });

    test('detects generic names narrowly', () => {
        expect(isGenericImageFilename('image.png')).toBe(true);
        expect(isGenericImageFilename('Screenshot (1).png')).toBe(true);
        expect(isGenericImageFilename('Screen Shot.png')).toBe(true);
        expect(isGenericImageFilename('Screenshot 2026-05-24.png')).toBe(false);
        expect(isGenericImageFilename('desktop_without_icons.jpg')).toBe(false);
    });

    test('builds bracket citations', () => {
        expect(buildAttachmentCitationText(['desktop.jpg', 'icon.png'])).toBe('[desktop.jpg] [icon.png]');
    });

    test('finds active attachment citation ranges', () => {
        expect(findAttachmentCitationRanges(
            'desktop [desktop.jpg] link [desktop.jpg](https://example.com) missing [other.jpg]',
            ['desktop.jpg'],
        )).toEqual([{ start: 8, end: 21 }]);
    });

    test('assigns sequential pasted-context filenames', () => {
        expect(nextPastedContextFilename([])).toBe('pasted-context-1.txt');
        expect(nextPastedContextFilename(['pasted-context-1.txt', 'notes.md'])).toBe('pasted-context-2.txt');
        expect(nextPastedContextFilename(['PASTED-CONTEXT-2.TXT'])).toBe('pasted-context-1.txt');
    });

    test('finds the names of links already in the draft', () => {
        const draft = 'see [image-1.png](/tmp/x/image-1.png) and [image-2.png] and [shot.png](<C:/a b/shot.png>)';
        expect(findImagePathCitationNames(draft)).toEqual(['image-1.png', 'shot.png']);
        expect(assignImageAttachmentFilenames([{ name: 'image.png', type: 'image/png' }], findImagePathCitationNames(draft)))
            .toEqual(['image-2.png']);
    });
});

describe('image save mode', () => {
    test('attaches only while the setting is off', () => {
        expect(imageSaveModeForModel(false, ['text'])).toBe('attach');
        expect(imageSaveModeForModel(false, ['text', 'image'])).toBe('attach');
        expect(imageSaveModeForModel(false, undefined)).toBe('attach');
    });

    test('a model without image input gets the saved file in place of the attachment', () => {
        expect(imageSaveModeForModel(true, ['text'])).toBe('instead');
    });

    test('a model that takes images gets the attachment and the saved file', () => {
        expect(imageSaveModeForModel(true, ['text', 'image'])).toBe('alongside');
        expect(imageSaveModeForModel(true, ['TEXT', 'IMAGE'])).toBe('alongside');
    });

    test('unknown model metadata counts as a model that takes the attachment', () => {
        expect(imageSaveModeForModel(true, undefined)).toBe('alongside');
    });
});

describe('links to files on disk', () => {
    test('finds links to local files, plain and in angle brackets', () => {
        const text = 'see [a.png](/tmp/oc/a.png) [b.png](<C:/Temp dir/b.png>)';
        expect(findLocalFileLinks(text).map(({ name, path }) => ({ name, path }))).toEqual([
            { name: 'a.png', path: '/tmp/oc/a.png' },
            { name: 'b.png', path: 'C:/Temp dir/b.png' },
        ]);
    });

    test('leaves links to the web alone', () => {
        expect(findLocalFileLinks('[docs](https://example.com/a.png)')).toEqual([]);
    });
});
