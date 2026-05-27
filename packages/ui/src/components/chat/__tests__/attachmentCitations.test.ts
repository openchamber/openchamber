import { describe, expect, test } from 'bun:test';

import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    findAttachmentCitationRanges,
    isGenericImageFilename,
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
});
