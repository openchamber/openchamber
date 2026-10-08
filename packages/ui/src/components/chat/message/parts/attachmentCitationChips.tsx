import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { INLINE_REFERENCE_CHIP_CLASS } from '@/lib/messages/inlineMessageLinks';
import { findAttachmentCitationRanges } from '../../attachmentCitations';

/** A run of text, or an inline element drawn inside it. */
export type InlineTextNode = string | React.ReactElement;

// eslint-disable-next-line react-refresh/only-export-components -- private chip drawn by the exported text splitter
const AttachmentCitationChip: React.FC<{ filename: string }> = ({ filename }) => (
    <span className={INLINE_REFERENCE_CHIP_CLASS} title={filename}>
        <FileTypeIcon filePath={filename} className="h-[1.1em] w-[1.1em]" />
        {filename}
    </span>
);

/**
 * Splits plain text into runs and file chips for each `[name]` citation of
 * one of `filenames`. The React counterpart of the Markdown path, for text
 * that is not rendered as Markdown: plain-mode user messages and comments.
 */
export function withAttachmentChips(
    text: string,
    filenames: readonly string[],
    keyPrefix: string,
): InlineTextNode[] {
    if (filenames.length === 0) return [text];
    const ranges = findAttachmentCitationRanges(text, [...filenames]);
    if (ranges.length === 0) return [text];
    const nodes: InlineTextNode[] = [];
    let cursor = 0;
    for (const range of ranges) {
        if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
        const filename = text.slice(range.start + 1, range.end - 1).trim();
        nodes.push(<AttachmentCitationChip key={`${keyPrefix}-${range.start}`} filename={filename} />);
        cursor = range.end;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}
