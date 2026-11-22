
import type { ChangeDesc } from '@codemirror/state';

import { findSessionLinks } from '@/lib/sessionLinks';

import type { ComposerChange, ComposerSelection } from './editor/ComposerEditor';
import { sessionLinkText } from './sessionReferences';

export interface PastedSessionIdRange {
    readonly sessionId: string;
    from: number;
    to: number;
}

type PastedChange = Pick<ComposerChange, 'value' | 'fromPaste' | 'fromValueProp'> & { changes: ChangeDesc };

export class PastedSessionIds {
    private expected: string | null = null;
    private readonly ranges = new Set<PastedSessionIdRange>();

    expect(sessionId: string): void {
        this.expected = sessionId;
    }

    applyChange({ value, changes, fromPaste, fromValueProp }: PastedChange): PastedSessionIdRange | null {
        const sessionId = this.expected;
        this.expected = null;
        if (fromValueProp) {
            this.ranges.clear();
            return null;
        }
        for (const range of this.ranges) {
            range.from = changes.mapPos(range.from, 1);
            range.to = changes.mapPos(range.to, -1);
        }
        if (!sessionId || !fromPaste) return null;
        let landed: PastedSessionIdRange | null = null;
        changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
            const offset = value.slice(fromB, toB).indexOf(sessionId);
            if (landed || offset < 0) return;
            landed = { sessionId, from: fromB + offset, to: fromB + offset + sessionId.length };
        });
        if (landed) this.ranges.add(landed);
        return landed;
    }

    settle(range: PastedSessionIdRange): boolean {
        return this.ranges.delete(range);
    }
}

export const sessionLinkOverPastedId = (
    value: string,
    range: PastedSessionIdRange,
    selection: ComposerSelection,
    ownOrigins: readonly string[],
): { link: string; selection: ComposerSelection } | null => {
    if (value.slice(range.from, range.to) !== range.sessionId) return null;
    const link = sessionLinkText(range.sessionId);
    const next = `${value.slice(0, range.from)}${link}${value.slice(range.to)}`;
    if (!findSessionLinks(next, ownOrigins).some((found) => found.start === range.from && found.link === link)) return null;
    const shifted = (position: number): number => {
        if (position <= range.from) return position;
        return position < range.to ? range.from + link.length : position + link.length - range.sessionId.length;
    };
    return { link, selection: { start: shifted(selection.start), end: shifted(selection.end) } };
};
