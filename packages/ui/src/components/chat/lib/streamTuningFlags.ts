// Switch for incremental whole-block highlighting in the shared code worker.
// Enabled by default; set the key in localStorage and reload to disable it:
//
//   openchamber_stream_highlight = full     tokenize each code block in one pass
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
    incrementalHighlight: (): boolean => read('openchamber_stream_highlight') !== 'full',
};
