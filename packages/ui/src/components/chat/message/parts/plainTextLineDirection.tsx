import React from 'react';
import { proseTextDirection } from '@/lib/i18n/textDirection';
import type { InlineTextNode } from './attachmentCitationChips';

/**
 * Starts each line of a plain-text message with a mark for the direction most
 * of its words run. The container resolves every line on its own
 * (`unicode-bidi: plaintext`) by its first strong letter, and the mark draws
 * that letter through CSS, so Arabic that opens with "React" runs right to
 * left beside an English line. Copied text keeps no mark. Chips are LTR
 * isolates and do not count; a line without letters gets no mark.
 */
export function withLineDirectionMarks(nodes: readonly InlineTextNode[], keyPrefix: string): InlineTextNode[] {
    const lines = [''];
    for (const node of nodes) {
        if (React.isValidElement<unknown>(node)) continue;
        const [first, ...rest] = node.split('\n');
        lines[lines.length - 1] += first;
        lines.push(...rest);
    }
    const directions = lines.map(proseTextDirection);
    const mark = (line: number): InlineTextNode[] => {
        const dir = directions[line];
        return dir ? [<span key={`${keyPrefix}-${line}`} data-oc-line-dir={dir} aria-hidden="true" />] : [];
    };

    const marked: InlineTextNode[] = mark(0);
    let line = 0;
    for (const node of nodes) {
        if (React.isValidElement<unknown>(node)) {
            marked.push(node);
            continue;
        }
        node.split('\n').forEach((segment, index) => {
            if (index > 0) {
                line += 1;
                marked.push('\n', ...mark(line));
            }
            if (segment) marked.push(segment);
        });
    }
    return marked;
}
