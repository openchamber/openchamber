import React from 'react';
import type { FormRequest } from '@/lib/opencode/model';
import type { RecoveredQuestion } from '@/sync/recoverable-questions';
import { dropFormDraft, formDraftScope } from '@/components/chat/formDrafts';

export const useDropSettledFormDrafts = (
    owner: { sessionId: string; directory: string },
    forms: readonly FormRequest[],
    recovered: readonly RecoveredQuestion[],
    runtimeKey: string,
): void => {
    const shown = React.useRef<{ key: string; forms: readonly FormRequest[] } | null>(null);
    const { sessionId, directory } = owner;
    const key = [runtimeKey, directory, sessionId].join('\u0000');
    React.useEffect(() => {
        const previous = shown.current;
        shown.current = { key, forms };
        if (previous?.key !== key) return;
        for (const form of previous.forms) {
            const stays = (item: FormRequest) => item.id === form.id && item.sessionID === form.sessionID;
            if (forms.some(stays) || recovered.some((question) => stays(question.form))) continue;
            dropFormDraft(formDraftScope(form, directory, runtimeKey));
        }
    }, [key, forms, recovered, directory, runtimeKey]);
};
