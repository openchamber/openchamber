import type { I18nKey, I18nParams } from '@/lib/i18n';

export class MermaidLoadFailure extends Error {
    key: I18nKey;
    params?: I18nParams;

    constructor(key: I18nKey, params?: I18nParams) {
        super(key);
        this.name = 'MermaidLoadFailure';
        this.key = key;
        this.params = params;
    }
}

const mermaidLoadFailure = (key: I18nKey, params?: I18nParams): MermaidLoadFailure => new MermaidLoadFailure(key, params);

export const isMermaidLoadFailure = (value: unknown): value is MermaidLoadFailure => value instanceof MermaidLoadFailure;

export const nextMermaidLoadRequestId = (current: number): number => current + 1;

export const isCurrentMermaidLoadRequest = (current: number, requestId: number): boolean => current === requestId;

const decodeMermaidDataUrl = (value: string): string => {
    const commaIndex = value.indexOf(',');
    if (commaIndex < 0) {
        throw mermaidLoadFailure('chat.toolOutputDialog.mermaid.dataUrlMalformed');
    }

    const metadata = value.slice(0, commaIndex).toLowerCase();
    const payload = value.slice(commaIndex + 1);
    if (metadata.includes(';base64')) {
        return atob(payload);
    }
    return decodeURIComponent(payload);
};

export const getMermaidDataUrlSourcePromise = (value: string): Promise<string> => Promise.resolve().then(() => decodeMermaidDataUrl(value));
