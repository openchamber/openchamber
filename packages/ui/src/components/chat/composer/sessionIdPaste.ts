import type { ChangeDesc } from '@codemirror/state';
import { parseSessionLink } from '@/lib/sessionLinks';
import type { ComposerEditorHandle } from './editor/ComposerEditor';
import { loadSessionLinkReference, sessionLinkText, type SessionReference } from './sessionReferences';
import { withInlineInsertionBoundaries } from './text';

type PasteRange = { from: number; to: number };
type PasteResult =
    | { status: 'resolved'; reference: SessionReference }
    | { status: 'unavailable' | 'cancelled' };

/** Only pending paste occurrences belong here; ordinary text never becomes a reference. */
export class SessionIdPaste {
    private pending = new Set<PasteRange>();

    clear(): void {
        this.pending.clear();
    }

    applyChange(changes: ChangeDesc, fromValueProp: boolean): void {
        if (fromValueProp) {
            this.clear();
            return;
        }
        for (const range of this.pending) {
            let edited = false;
            changes.iterChangedRanges((from, to) => {
                if (from < range.to && to > range.from) edited = true;
            });
            if (edited) this.pending.delete(range);
            else {
                range.from = changes.mapPos(range.from, 1);
                range.to = changes.mapPos(range.to, -1);
            }
        }
    }

    /** Null leaves native paste untouched. A recognized ID is inserted before its read starts. */
    paste(text: string, editor: ComposerEditorHandle, isCurrent: () => boolean): Promise<PasteResult> | null {
        const id = text.trim();
        const target = id.startsWith('ses_') ? parseSessionLink(id, []) : null;
        if (!target) return null;

        const from = editor.getSelection().start;
        editor.insertText(text, 'input.paste');
        // Measure CodeMirror's insertion: clipboard CRLFs have already become LF.
        const range = { from, to: editor.getSelection().end };
        const inserted = editor.getValue().slice(range.from, range.to);
        this.pending.add(range);

        return loadSessionLinkReference(target).catch(() => null).then((reference): PasteResult => {
            if (!this.pending.delete(range) || !isCurrent()) return { status: 'cancelled' };
            if (!reference) return { status: 'unavailable' };
            const value = editor.getValue();
            const insert = withInlineInsertionBoundaries(
                inserted.replace(id, sessionLinkText(target.sessionId)),
                value.slice(0, range.from), value.slice(range.to),
            );
            editor.replacePastedRange(range.from, range.to, insert);
            return { status: 'resolved', reference };
        });
    }
}
