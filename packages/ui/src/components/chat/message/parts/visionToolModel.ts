import { tryParseJsonOutput } from '../toolRenderers';

// Vision tool output: the openchamber tool envelope carries the description in
// `data`, or an error message in `error`. Unparseable output falls through to
// the generic JSON renderer so nothing is hidden.
interface OpenChamberVisionResultData {
    description?: unknown;
    model?: unknown;
    imagePath?: unknown;
    imageFilename?: unknown;
    imageMime?: unknown;
    imageSize?: unknown;
}

export const parseVisionRunOutput = (output: string): { data: OpenChamberVisionResultData | null; error: string | null } => {
    if (!output) return { data: null, error: null };
    const envelope = tryParseJsonOutput(output);
    if (!envelope.isJson || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
        return { data: null, error: null };
    }
    const record = envelope.data as Record<string, unknown>;
    const data = record.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        return { data: data as OpenChamberVisionResultData, error: null };
    }
    const error = record.error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) return { data: null, error: message };
    }
    return { data: null, error: null };
};
