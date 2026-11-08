import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { CHIP_TRAILING_PUNCTUATION, INLINE_REFERENCE_CHIP_CLASS, INTERACTIVE_REFERENCE_CHIP_CLASS, REFERENCE_CHIP_LABEL_CLASS } from '@/lib/messages/inlineMessageLinks';
import { findAttachmentCitationRanges } from '../../attachmentCitations';

/** A run of text, or an inline element drawn inside it. */
export type InlineTextNode = string | React.ReactElement;

// Inline minimums opt out of the mobile 36px button floor.
const INLINE_BUTTON_STYLE = { minHeight: 0, minWidth: 0 };

// oxlint-disable-next-line react/only-export-components -- private chip drawn by the exported text splitter
const AttachmentCitationChip: React.FC<{ filename: string; openable: boolean }> = ({ filename, openable }) => {
    const content = (
        <>
            <FileTypeIcon filePath={filename} className="h-[1.1em] w-[1.1em] shrink-0" />
            <span className={REFERENCE_CHIP_LABEL_CLASS}>{filename}</span>
        </>
    );
    if (!openable) {
        return <span className={INLINE_REFERENCE_CHIP_CLASS} title={filename}>{content}</span>;
    }
    // The surrounding message text opens the file by `data-attachment-open`.
    return (
        <button
            type="button"
            className={INTERACTIVE_REFERENCE_CHIP_CLASS}
            style={INLINE_BUTTON_STYLE}
            data-attachment-open={filename}
            title={filename}
        >
            {content}
        </button>
    );
};

/**
 * Splits plain text into runs and file chips for each `[name]` citation of
 * one of `filenames`. The React counterpart of the Markdown path, for text
 * that is not rendered as Markdown: plain-mode user messages and comments.
 * A chip is a button only where `isOpenable` says its file opens on click;
 * surfaces that open nothing (the composer, the queue, context blocks) leave
 * it out and get labels.
 */
export function withAttachmentChips(
    text: string,
    filenames: readonly string[],
    keyPrefix: string,
    isOpenable?: (filename: string) => boolean,
): InlineTextNode[] {
    if (filenames.length === 0) return [text];
    const ranges = findAttachmentCitationRanges(text, [...filenames]);
    if (ranges.length === 0) return [text];
    const nodes: InlineTextNode[] = [];
    let cursor = 0;
    for (const range of ranges) {
        if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
        const filename = text.slice(range.start + 1, range.end - 1).trim();
        nodes.push(
            <AttachmentCitationChip
                key={`${keyPrefix}-${range.start}`}
                filename={filename}
                openable={isOpenable?.(filename) ?? false}
            />,
        );
        cursor = range.end;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}

/**
 * Keeps each chip and the punctuation typed right after it on one line, as a
 * word and its comma are (`CHIP_TRAILING_PUNCTUATION`): the two go into one
 * `nowrap` span, the punctuation still plain text.
 */
export function glueChipPunctuation(nodes: readonly InlineTextNode[], keyPrefix: string): InlineTextNode[] {
    const glued: InlineTextNode[] = [];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const next = nodes[index + 1];
        if (!React.isValidElement<unknown>(node) || next === undefined || React.isValidElement<unknown>(next)) {
            glued.push(node);
            continue;
        }
        const trailing = CHIP_TRAILING_PUNCTUATION.exec(next)?.[0];
        if (!trailing) {
            glued.push(node);
            continue;
        }
        glued.push(<span key={`${keyPrefix}-${index}`} className="whitespace-nowrap">{node}{trailing}</span>);
        if (next.length > trailing.length) glued.push(next.slice(trailing.length));
        index++;
    }
    return glued;
}
