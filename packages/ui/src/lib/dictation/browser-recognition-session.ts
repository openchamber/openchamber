/** Owns one Web Speech session. Stop waits for the final result; cancel discards it. */
export type BrowserRecognition = Pick<SpeechRecognition,
    'start' | 'stop' | 'abort' | 'lang' | 'continuous' | 'interimResults' | 'onresult' | 'onerror' | 'onend'>;

interface RecognitionCallbacks {
    onText: (text: string) => void;
    onError: (code: string) => void;
}

const FINISH_TIMEOUT_MS = 5000;

export class BrowserRecognitionSession {
    private state: 'idle' | 'listening' | 'finishing' | 'closed' = 'idle';
    private previousText = '';
    private text = '';
    private finishing: Promise<string | null> | null = null;
    private resolveFinish: ((text: string | null) => void) | null = null;
    private finishTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly recognition: BrowserRecognition, private readonly callbacks: RecognitionCallbacks) {}

    start(language: string): void {
        if (this.state !== 'idle') return;
        this.state = 'listening';
        const recognition = this.recognition;
        recognition.lang = language;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (event) => {
            if (this.state === 'closed') return;
            // The result list contains all finals and the current interim
            // hypothesis. Rebuild it rather than appending repeated finals.
            const parts = [this.previousText];
            for (let i = 0; i < event.results.length; i++) {
                parts.push(event.results[i][0].transcript);
            }
            this.text = parts.map((part) => part.trim()).filter(Boolean).join(' ');
            this.callbacks.onText(this.text);
        };
        recognition.onerror = (event) => this.fail(event.error);
        recognition.onend = () => {
            if (this.state === 'finishing') {
                this.close(this.text);
            } else if (this.state === 'listening') {
                // Browsers can end continuous recognition at a silence boundary.
                // Preserve that segment; the next start has a fresh result list.
                this.previousText = this.text;
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
        }
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
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        if (this.finishTimer) clearTimeout(this.finishTimer);
        this.finishTimer = null;
        this.resolveFinish?.(result);
        this.resolveFinish = null;
    }
}
