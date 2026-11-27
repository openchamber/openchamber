import { isInvisibleText } from '@/lib/invisibleText';
import type { Part } from '@/lib/opencode/model';
import { executeNamespace } from '@/lib/opencode/tools';
import { isStandalonePart } from './activityGroups';

type PartsByMessage = Readonly<Record<string, Part[]>>;

const isSamePartForRows = (previous: Part, next: Part): boolean => {
    if (previous === next) return true;
    if (previous.id !== next.id || previous.type !== next.type) return false;
    if (previous.type === 'tool' && next.type === 'tool') {
        return previous.tool === next.tool
            && previous.state.status === next.state.status
            && isStandalonePart(previous) === isStandalonePart(next)
            && (previous.state.status === 'pending' ? undefined : executeNamespace(previous.state.metadata))
                === (next.state.status === 'pending' ? undefined : executeNamespace(next.state.metadata));
    }
    if ((previous.type === 'text' || previous.type === 'reasoning') && (next.type === 'text' || next.type === 'reasoning')) {
        const ended = next.time?.end !== undefined;
        if ((previous.time?.end !== undefined) !== ended) return false;
        return isInvisibleText(previous.text) === isInvisibleText(next.text) && (!ended || previous.text === next.text);
    }
    return true;
};

const isSameMessageForRows = (previous: readonly Part[], next: readonly Part[]): boolean => (
    previous === next || (previous.length === next.length && previous.every((part, index) => isSamePartForRows(part, next[index])))
);

export const buildSameRows = (previous: PartsByMessage, next: PartsByMessage): boolean => {
    const ids = Object.keys(next);
    return Object.keys(previous).length === ids.length
        && ids.every((id) => previous[id] !== undefined && isSameMessageForRows(previous[id], next[id]));
};
