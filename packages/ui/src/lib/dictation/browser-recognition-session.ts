/** Owns one Web Speech session. Stop waits for the final result; cancel discards it. */
export type BrowserRecognition = Pick<SpeechRecognition,
    'start' | 'stop' | 'abort' | 'lang' | 'continuous' | 'interimResults' | 'onresult' | 'onnomatch' | 'onerror' | 'onend'>;

interface RecognitionCallbacks {
    onText: (text: string) => void;
    onError: (code: string) => void;
}

const FINISH_TIMEOUT_MS = 5000;

/**
 * Join two recognized segments. Whitespace inside one result list belongs to
 * the recognition service and is kept raw, so only the seam between automatic
 * restarts gets a space, and only when neither side already carries one.
 */
export const joinRecognitionSegments = (previous: string, next: string): string => {
    if (!previous) return next;
    if (!next) return previous;
    if (/\s$/.test(previous) || /^\s/.test(next)) return previous + next;
    return `${previous} ${next}`;
};

export class BrowserRecognitionSession {
    /**
     * The session currently allowed to capture. The composer and the settings
     * preview each own a hook instance, and starting one while the other
     * records must refuse rather than capture side by side.
     */
    private static active: BrowserRecognitionSession | null = null;

    private state: 'idle' | 'listening' | 'finishing' | 'closed' = 'idle';
    private previousFinalText = '';
    private finalText = '';
    private interimText = '';
    private finishing: Promise<string | null> | null = null;
    private resolveFinish: ((text: string | null) => void) | null = null;
    private finishTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly recognition: BrowserRecognition, private readonly callbacks: RecognitionCallbacks) {}

    /** Claim the page-wide capture ownership and start listening. False when another session owns it. */
    start(language: string): boolean {
        if (this.state !== 'idle') return false;
        if (BrowserRecognitionSession.active) return false;
        BrowserRecognitionSession.active = this;
        this.state = 'listening';
        const recognition = this.recognition;
        recognition.lang = language;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (event) => {
            if (this.state === 'closed') return;
            // The result list is cumulative: every final plus the current
            // interim hypothesis. Only finals count toward confirmation;
            // the interim stays a live preview.
            const finals: string[] = [];
            const interims: string[] = [];
            for (let i = 0; i < event.results.length; i++) {
                const result = event.results[i];
                const transcript = result[0]?.transcript ?? '';
                if (result.isFinal) {
                    finals.push(transcript);
                } else {
                    interims.push(transcript);
                }
            }
            this.finalText = joinRecognitionSegments(this.previousFinalText, finals.join(''));
            this.interimText = interims.join('');
            this.callbacks.onText(joinRecognitionSegments(this.finalText, this.interimText));
        };
        // No significant recognition. Nothing to accumulate; a confirmation
        // in flight settles with whatever finalized so far.
        recognition.onnomatch = () => {
            if (this.state === 'finishing') {
                this.close(this.finalText ? this.finalText : null);
            }
        };
        recognition.onerror = (event) => this.fail(event.error);
        recognition.onend = () => {
            if (this.state === 'finishing') {
                this.close(this.finalText ? this.finalText : null);
            } else if (this.state === 'listening') {
                // Browsers can end continuous recognition at a silence boundary.
                // Carry only finalized text; the next start has a fresh result list.
                this.previousFinalText = this.finalText;
                this.finalText = this.previousFinalText;
                this.interimText = '';
                try {
                    recognition.start();
                } catch {
                    this.fail('start-failed');
                }
            }
        };
        try {
            recognition.start();
        } catch {
            this.fail('start-failed');
            return false;
        }
        return true;
    }

    finish(): Promise<string | null> {
        if (this.finishing) return this.finishing;
        if (this.state !== 'listening') return Promise.resolve(null);
        this.state = 'finishing';
        this.finishing = new Promise((resolve) => { this.resolveFinish = resolve; });
        this.finishTimer = setTimeout(() => this.fail('timeout'), FINISH_TIMEOUT_MS);
        try {
            this.recognition.stop();
        } catch {
            this.fail('stop-failed');
        }
        return this.finishing;
    }

    cancel(): void {
        if (this.state === 'closed') return;
        this.close(null);
        this.abort();
    }

    private fail(code: string): void {
        if (this.state === 'closed') return;
        this.close(null);
        this.abort();
        this.callbacks.onError(code);
    }

    private abort(): void {
        try { this.recognition.abort(); } catch { /* Already stopped. */ }
    }

    private close(result: string | null): void {
        this.state = 'closed';
        if (BrowserRecognitionSession.active === this) {
            BrowserRecognitionSession.active = null;
        }
        this.recognition.onresult = null;
        this.recognition.onnomatch = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        if (this.finishTimer) clearTimeout(this.finishTimer);
        this.finishTimer = null;
        this.resolveFinish?.(result);
        this.resolveFinish = null;
    }
}
