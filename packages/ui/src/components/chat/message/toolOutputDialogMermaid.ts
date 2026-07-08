import type { I18nKey, I18nParams } from '@/lib/i18n';

export type MermaidLoadFailure = {
    key: I18nKey;
    params?: I18nParams;
};

const mermaidLoadFailure = (key: I18nKey, params?: I18nParams): MermaidLoadFailure => ({ key, params });

export const isMermaidLoadFailure = (value: unknown): value is MermaidLoadFailure => (
    typeof value === 'object'
    && value !== null
    && 'key' in value
    && typeof (value as MermaidLoadFailure).key === 'string'
);

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
