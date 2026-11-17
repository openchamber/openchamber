import type { Message } from '@/lib/opencode/model';

export const holdPendingSynthetic = <T extends { info: Message }>(records: T[]): T[] => {
    const shown = records.filter(({ info }) => !(info.role === 'synthetic' && info.pending));
    return shown.length === records.length ? records : shown;
};
