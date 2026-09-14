import { describe, expect, test } from 'bun:test';
import { BrowserRecognitionSession, joinRecognitionSegments, type BrowserRecognition } from './browser-recognition-session';

class RecognitionFake implements BrowserRecognition {
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
    onnomatch: ((event: SpeechRecognitionEvent) => void) | null = null;
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
    const nomatch = () => {
        const event = Object.assign(new Event('nomatch'), { resultIndex: 0, results: results([]), emma: null, interpretation: null });
        recognition.onnomatch?.(event);
    };
    return { recognition, session, texts, errors, emit, nomatch };
}

describe('browser recognition session', () => {
    test('replaces interim hypotheses and does not duplicate repeated final results', async () => {
        const { session, recognition, texts, emit } = setup();
        expect(session.start('tr-TR')).toBe(true);
        expect(session.start('en-US')).toBe(false);
        expect(recognition.starts).toBe(1);
        expect(recognition.lang).toBe('tr-TR');
        emit([{ text: 'Merhaba ', final: true }, { text: 'dün', final: false }]);
        emit([{ text: 'Merhaba ', final: true }, { text: 'dünya', final: true }]);
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

    test('an interim hypothesis alone never confirms', async () => {
        const { session, recognition, emit } = setup();
        session.start('tr');
        emit([{ text: 'unfinalized', final: false }]);
        const finishing = session.finish();
        recognition.onend?.(new Event('end'));
        expect(await finishing).toBeNull();
    });

    test('nomatch settles a confirmation with finalized text only', async () => {
        const { session, recognition, emit, nomatch } = setup();
        session.start('tr');
        emit([{ text: 'kesin ', final: true }, { text: 'mola', final: false }]);
        const finishing = session.finish();
        nomatch();
        expect(await finishing).toBe('kesin ');
        expect(recognition.starts).toBe(1);
    });

    test('nomatch while listening keeps the session alive', async () => {
        const { session, recognition, emit, nomatch, texts } = setup();
        session.start('tr');
        nomatch();
        emit([{ text: 'devam', final: true }]);
        const finishing = session.finish();
        recognition.onend?.(new Event('end'));
        expect(await finishing).toBe('devam');
        expect(texts.at(-1)).toBe('devam');
        expect(recognition.starts).toBe(1);
    });

    test('keeps raw transcript boundaries inside one result list', async () => {
        const { session, recognition, emit } = setup();
        session.start('zh-CN');
        emit([{ text: '你好', final: true }, { text: '世界', final: true }]);
        emit([{ text: '你好', final: true }, { text: '世界', final: true }, { text: 'Hello', final: true }, { text: ', world', final: true }]);
        const finishing = session.finish();
        recognition.onend?.(new Event('end'));
        expect(await finishing).toBe('你好世界Hello, world');
    });

    test('cancel during finalization settles without delivering text and detaches handlers', async () => {
        const { session, recognition, emit, texts, nomatch } = setup();
        session.start('tr');
        emit([{ text: 'taslak', final: false }]);
        const finishing = session.finish();
        session.cancel();
        session.cancel();
        expect(await finishing).toBeNull();
        expect(recognition.aborts).toBe(1);
        expect(recognition.onresult).toBeNull();
        expect(recognition.onnomatch).toBeNull();
        expect(recognition.onend).toBeNull();
        emit([{ text: 'late', final: true }]);
        nomatch();
        recognition.onend?.(new Event('end'));
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

    test('a second owner is refused while one records, then may start after release', () => {
        const first = setup();
        const second = setup();
        expect(first.session.start('tr')).toBe(true);
        expect(second.session.start('en')).toBe(false);
        expect(second.recognition.starts).toBe(0);
        first.session.cancel();
        expect(second.session.start('en')).toBe(true);
        second.emit([{ text: 'still active', final: true }]);
        expect(second.texts).toEqual(['still active']);
        expect(second.recognition.aborts).toBe(0);
        second.session.cancel();
    });
});

describe('joinRecognitionSegments', () => {
    test('adds a space only when the seam has none', () => {
        expect(joinRecognitionSegments('', 'ikinci')).toBe('ikinci');
        expect(joinRecognitionSegments('birinci', '')).toBe('birinci');
        expect(joinRecognitionSegments('birinci', 'ikinci')).toBe('birinci ikinci');
        expect(joinRecognitionSegments('birinci ', 'ikinci')).toBe('birinci ikinci');
        expect(joinRecognitionSegments('birinci', ' ikinci')).toBe('birinci ikinci');
        expect(joinRecognitionSegments('你好', '世界')).toBe('你好 世界');
    });
});
