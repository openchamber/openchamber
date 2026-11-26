import type { Message } from '@/lib/opencode/model';

const COMMAND = /^\s*<background-result\b[^>]*?\bcommand="([\s\S]*?)">\n/;

export const shellCommandOf = (message: Message): string => {
    if (message.role !== 'synthetic') return '';
    return (message.text.match(COMMAND)?.[1] ?? message.description ?? '').replace(/\s+/g, ' ').trim();
};
