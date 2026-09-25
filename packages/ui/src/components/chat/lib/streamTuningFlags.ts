// Switches for the streaming optimisations, so each one can be measured
// against its absence on a single build. Both are on by default; set the key
// in localStorage and reload to turn one off:
//
//   openchamber_stream_lex_reuse = 0        lex the whole message on every new line of code
//   openchamber_stream_highlight = full     highlight the whole code block on every new line
//
// Read once: a flag that changed mid-stream would compare nothing.

const cache = new Map<string, string | null>();

const read = (key: string): string | null => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let value: string | null;
    try {
        value = globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        value = null;
    }
    cache.set(key, value);
    return value;
};

export const streamTuning = {
    reuseLiveSplit: (): boolean => read('openchamber_stream_lex_reuse') !== '0',
    incrementalHighlight: (): boolean => read('openchamber_stream_highlight') !== 'full',
};
