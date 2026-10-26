/**
 * Large plain-text paste → virtual file attachment helpers.
 *
 * Detect when clipboard text is large enough that inserting it into the
 * composer would clutter the prompt, and build an in-memory text/plain File
 * the attachment pipeline can send like any other .txt attachment.
 */

import { resolveShortcutEventKey } from '@/lib/shortcuts';

export const LARGE_TEXT_PASTE_CHAR_THRESHOLD = 2000;
export const LARGE_TEXT_PASTE_LINE_THRESHOLD = 25;

const DOUBLE_PASTE_WINDOW_MS = 1000;

const countLines = (text: string): number => {
    let lines = 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
};

/**
 * Whether pasted plain text should be offered (or auto-handled) as a file
 * attachment instead of being inserted into the composer.
 *
 * Empty / whitespace-only pastes are never large. Thresholds are OR'd:
 * character count or line count is enough.
 */
export const isLargePlainTextPaste = (
    text: string,
    options?: {
        charThreshold?: number;
        lineThreshold?: number;
    },
): boolean => {
    if (!text || !text.trim()) {
        return false;
    }

    const charThreshold = options?.charThreshold ?? LARGE_TEXT_PASTE_CHAR_THRESHOLD;
    const lineThreshold = options?.lineThreshold ?? LARGE_TEXT_PASTE_LINE_THRESHOLD;

    if (text.length >= charThreshold) {
        return true;
    }

    return countLines(text) >= lineThreshold;
};

export const createPastedContextFile = (text: string, filename: string): File => (
    new File([text], filename, {
        type: 'text/plain',
        lastModified: Date.now(),
    })
);

interface PasteSnapshot {
    value: string;
    selection: { start: number; end: number };
    scope: string;
}

export interface LargeTextPasteCandidate {
    clipboardText: string;
    value: string;
    scope: string;
    from: number;
    to: number;
    pastedAt: number;
}

type PasteGestureState =
    | { kind: 'idle' }
    | { kind: 'pending'; clipboardText: string; scope: string; from: number; pastedAt: number }
    | { kind: 'inline' | 'ready' | 'attaching'; candidate: LargeTextPasteCandidate };

/** One composer-owned, short-lived gesture. The first insertion stays native. */
export class LargeTextPasteGesture {
    private state: PasteGestureState = { kind: 'idle' };
    private keyboardPaste = false;
    private expiry: ReturnType<typeof setTimeout> | null = null;

    invalidate(): void {
        if (this.expiry !== null) clearTimeout(this.expiry);
        this.expiry = null;
        this.keyboardPaste = false;
        this.state = { kind: 'idle' };
    }

    keyDown(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>): void {
        if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;
        const paste = resolveShortcutEventKey(event).toLowerCase() === 'v'
            && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.repeat;
        if (!paste) this.invalidate();
        this.keyboardPaste = paste;
    }

    keyUp(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>): void {
        if (resolveShortcutEventKey(event).toLowerCase() === 'v') this.keyboardPaste = false;
    }

    beginPaste(text: string, snapshot: PasteSnapshot, now = performance.now()): LargeTextPasteCandidate | null {
        const keyboardPaste = this.keyboardPaste;
        const previous = this.state;
        this.invalidate();
        if (!keyboardPaste || !isLargePlainTextPaste(text)) return null;
        if (previous.kind === 'inline') {
            const candidate = previous.candidate;
            const elapsed = now - candidate.pastedAt;
            if (elapsed >= 0 && elapsed < DOUBLE_PASTE_WINDOW_MS && text === candidate.clipboardText
                && this.matches(candidate, snapshot)) {
                this.state = { kind: 'ready', candidate };
                return candidate;
            }
        }
        this.state = { kind: 'pending', clipboardText: text, scope: snapshot.scope, from: snapshot.selection.start, pastedAt: now };
        this.expiry = setTimeout(() => this.invalidate(), DOUBLE_PASTE_WINDOW_MS);
        return null;
    }

    change(change: PasteSnapshot & { fromPaste: boolean; insertedText: string }): void {
        const pending = this.state;
        if (pending.kind !== 'pending') {
            this.invalidate();
            return;
        }
        const isFirstInsertion = change.fromPaste
            && change.scope === pending.scope
            && change.selection.start === change.selection.end
            && change.selection.end - pending.from === change.insertedText.length;
        if (!isFirstInsertion) {
            this.invalidate();
            return;
        }
        // insertedText and the caret came from CodeMirror, including CRLF normalization.
        this.state = { kind: 'inline', candidate: {
            clipboardText: pending.clipboardText, value: change.value, scope: pending.scope,
            from: pending.from, to: change.selection.end, pastedAt: pending.pastedAt,
        } };
    }

    async convert(
        candidate: LargeTextPasteCandidate,
        attach: () => Promise<boolean>,
        read: () => PasteSnapshot | null,
        replace: (from: number, to: number, citation: string) => void,
        citation: string,
    ): Promise<boolean> {
        if (this.state.kind !== 'ready' || this.state.candidate !== candidate) return false;
        const attaching: PasteGestureState = { kind: 'attaching', candidate };
        this.state = attaching;
        try {
            if (!await attach() || this.state !== attaching) return false;
            const snapshot = read();
            if (!snapshot || !this.matches(candidate, snapshot)) return false;
            this.invalidate();
            replace(candidate.from, candidate.to, citation);
            return true;
        } finally {
            if (this.state === attaching) this.invalidate();
        }
    }

    private matches(candidate: LargeTextPasteCandidate, snapshot: PasteSnapshot): boolean {
        return candidate.scope === snapshot.scope && candidate.value === snapshot.value
            && snapshot.selection.start === candidate.to && snapshot.selection.end === candidate.to;
    }
}
