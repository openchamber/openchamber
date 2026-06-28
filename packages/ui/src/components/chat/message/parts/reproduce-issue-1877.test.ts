/**
 * Reproduction test for issue #1877.
 *
 * Bug: When a user message is expanded (long text that exceeds the scroll
 * container height), the collapse button (top-right corner) scrolls out of
 * view. The user must scroll back to the very top to collapse the message.
 *
 * Root cause: In UserTextPart.tsx, the collapse button uses `position: absolute`
 * (`absolute top-0 right-0`). When the parent scroll container
 * (MessageBody.tsx's `overflow-y-auto` with `max-height: 40vh`) scrolls, the
 * absolutely-positioned button scrolls with the content.
 *
 * The fix would be to use `position: sticky` on a wrapper around the button
 * so it stays visible at the top of the scroll container.
 */

import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Issue #1877 - collapse button scrolls out of view', () => {
    const userTextPartPath = path.join(__dirname, 'UserTextPart.tsx');

    test('collapse button uses absolute (not sticky) positioning — confirming the bug', () => {
        const source = fs.readFileSync(userTextPartPath, 'utf-8');

        // The collapse button is rendered with absolute positioning
        // (line ~203): className="absolute top-0 right-0 z-10 ..."
        expect(source).toContain('absolute top-0 right-0');

        // No sticky positioning is used in the file at all
        expect(source).not.toContain('sticky');
    });

    test('collapse button is inside a relative container that scrolls with content', () => {
        const source = fs.readFileSync(userTextPartPath, 'utf-8');

        // The outer wrapper is `div.relative` (line 198), which means
        // `position: absolute` on the button anchors to this wrapper.
        // Since this wrapper is inside MessageBody.tsx's scrollable div
        // (`overflow-y-auto` with `max-height: 40vh`), the button
        // scrolls with the content.
        expect(source).toContain('<div className="relative"');
    });

    test('scroll container in MessageBody.tsx uses overflow-y-auto confirming button scrolls away', () => {
        const messageBodyPath = path.join(
            __dirname,
            '..',
            'MessageBody.tsx',
        );
        const source = fs.readFileSync(messageBodyPath, 'utf-8');

        // The scrollable container uses overflow-y-auto (line 597)
        expect(source).toContain('overflow-y-auto');

        // The max-height is set to 40% of the chat scroll area (line 600)
        expect(source).toContain('maxHeight');
        expect(source).toContain('0.4');
    });
});
