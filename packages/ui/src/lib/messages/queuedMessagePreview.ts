import type { QueuedMessage } from '@/stores/messageQueueStore';
import type { ContextPartPayload } from './contextParts';

function contextPreview(payload: ContextPartPayload): string {
    switch (payload.kind) {
        case 'code-comment':
            return payload.text.trim() || payload.code.trim() || payload.fileLabel;
        case 'chat-quote':
        case 'file-quote':
            return payload.text.trim() || payload.quote;
        case 'browser-annotation':
            return payload.text.trim() || payload.prompt.trim() || payload.pageUrl;
        case 'pr-comment':
            return payload.text.trim() || payload.body.trim() || payload.label;
        case 'pr-check':
            return payload.text.trim() || payload.label.trim() || payload.output;
        case 'terminal':
            return payload.output.trim() || payload.terminalLabel;
        case 'github-issue':
        case 'github-pr':
        case 'linear-issue':
            return payload.title.trim() || payload.url;
    }
}

/** Display-only summary; never substitute it for the editable or delivered text. */
export function getQueuedMessagePreview(message: Pick<QueuedMessage, 'content' | 'context' | 'contextPreview' | 'attachments'>): string {
    let text = message.content.trim() || message.contextPreview?.trim() || '';
    if (!text) {
        for (const part of message.context ?? []) {
            if (part.kind === 'instruction') continue;
            text = (part.kind === 'context' ? contextPreview(part.metadata.openchamberContext) : part.text).trim();
            if (text) break;
        }
    }
    text ||= message.attachments?.[0]?.filename ?? '';
    const firstLine = text.split('\n', 1)[0];
    return firstLine.slice(0, 100) + (text.length > firstLine.length || firstLine.length > 100 ? '...' : '');
}
