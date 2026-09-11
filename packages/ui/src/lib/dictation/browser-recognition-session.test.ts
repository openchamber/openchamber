import { describe, expect, test } from 'bun:test';
import { BrowserRecognitionSession, type BrowserRecognition } from './browser-recognition-session';

class RecognitionFake implements BrowserRecognition {
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
    onend: ((event: Event) => void) | null = null;
    starts = 0;
    stops = 0;
    aborts = 0;
    start() { this.starts++; }
    stop() { this.stops++; }
    abort() { this.aborts++; }
}

// Web Speech's array-like lists also implement item().
const results = (parts: Array<{ text: string; final: boolean }>) => {
    const entries = parts.map(({ text, final }) => {
        const alternative = { transcript: text, confidence: 1 };
        return Object.assign([alternative], { isFinal: final, item: () => alternative });
    });
    return Object.assign(entries, { item: (index: number) => entries[index] });
};

function setup() {
    const recognition = new RecognitionFake();
    const texts: string[] = [];
    const errors: string[] = [];
    const session = new BrowserRecognitionSession(recognition, {
        onText: (text) => texts.push(text), onError: (code) => errors.push(code),
    });
    const emit = (parts: Array<{ text: string; final: boolean }>) => {
        const event = Object.assign(new Event('result'), { resultIndex: 0, results: results(parts), emma: null, interpretation: null });
        recognition.onresult?.(event);
    };
    return { recognition, session, texts, errors, emit };
}

describe('browser recognition session', () => {
    test('replaces interim hypotheses and does not duplicate repeated final results', async () => {
        const { session, recognition, texts, emit } = setup();
        session.start('tr-TR');
        session.start('en-US');
        expect(recognition.starts).toBe(1);
        expect(recognition.lang).toBe('tr-TR');
        emit([{ text: 'Merhaba', final: true }, { text: 'dün', final: false }]);
        emit([{ text: 'Merhaba', final: true }, { text: 'dünya', final: true }]);
        expect(texts).toEqual(['Merhaba dün', 'Merhaba dünya']);
        const finishing = session.finish();
        expect(session.finish()).toBe(finishing);
        expect(recognition.stops).toBe(1);
        recognition.onend?.(new Event('end'));
        expect(await finishing).toBe('Merhaba dünya');
    });

    test('waits for the final result produced by stop instead of inserting the interim early', async () => {
        const { session, recognition, emit } = setup();
        session.start('tr');
        emit([{ text: 'yar', final: false }]);
        const finishing = session.finish();
        emit([{ text: 'yarın', final: true }]);
        recognition.onend?.(new Event('end'));
        expect(await finishing).toBe('yarın');
        expect(recognition.starts).toBe(1);
    });

    test('cancel during finalization settles without delivering text and detaches handlers', async () => {
        const { session, recognition, emit, texts } = setup();
        session.start('tr');
        emit([{ text: 'taslak', final: false }]);
        const finishing = session.finish();
        session.cancel();
        session.cancel();
        expect(await finishing).toBeNull();
        expect(recognition.aborts).toBe(1);
        expect(recognition.onresult).toBeNull();
        expect(recognition.onend).toBeNull();
        expect(texts).toEqual(['taslak']);
    });

    for (const code of ['not-allowed', 'service-not-allowed', 'network', 'no-speech'] as const) {
        test(`${code} ends the session, keeps recognized text and does not restart`, async () => {
            const { session, recognition, emit, texts, errors } = setup();
            session.start('tr');
            emit([{ text: 'korunacak metin', final: true }]);
            recognition.onerror?.(Object.assign(new Event('error'), { error: code, message: '' }));
            expect(await session.finish()).toBeNull();
            expect(errors).toEqual([code]);
            expect(texts).toEqual(['korunacak metin']);
            expect(recognition.aborts).toBe(1);
            expect(recognition.onend).toBeNull();
        });
    }

    test('preserves completed text across a natural recognition restart', async () => {
        const { session, recognition, emit, texts } = setup();
        session.start('tr');
        emit([{ text: 'birinci', final: true }]);
        recognition.onend?.(new Event('end'));
        expect(recognition.starts).toBe(2);
        emit([{ text: 'ikinci', final: true }]);
        const finishing = session.finish();
        recognition.onend?.(new Event('end'));
        expect(await finishing).toBe('birinci ikinci');
        expect(texts.at(-1)).toBe('birinci ikinci');
    });

    test('never shares recognition ownership between preview and composer', () => {
        const first = setup();
        const second = setup();
        first.session.start('tr');
        second.session.start('en');
        first.session.cancel();
        second.emit([{ text: 'still active', final: true }]);
        expect(second.texts).toEqual(['still active']);
        expect(second.recognition.aborts).toBe(0);
        second.session.cancel();
    });
});
