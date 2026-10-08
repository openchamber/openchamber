import { describe, expect, test } from 'bun:test';

import { buildAttachmentHref, parseAttachmentHref } from './inlineMessageLinks';

describe('attachment citation links', () => {
    test('round-trip names that would otherwise break a Markdown link target', () => {
        const link = { filename: "shot (2x)'s copy.png", iconId: 'png' };
        const href = buildAttachmentHref(link);

        expect(/[()' ]/.test(href)).toBe(false);
        expect(parseAttachmentHref(href)).toEqual(link);
    });

    test('rejects other links and malformed attachment links', () => {
        expect(parseAttachmentHref('#openchamber-skill:review')).toBeNull();
        expect(parseAttachmentHref('#openchamber-attachment:png')).toBeNull();
        expect(parseAttachmentHref('#openchamber-attachment:png:%E0%A4%A')).toBeNull();
    });
});
