import React from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMessageSelectionStore, useMessageUnitSelected } from '@/stores/useMessageSelectionStore';

type MessageSelectionMarkProps = {
    sessionId: string | null | undefined;
    unitKey: string | null;
    kind: 'prompt' | 'answer';
    showCheckbox?: boolean;
};

export const MessageSelectionMark: React.FC<MessageSelectionMarkProps> = ({ sessionId, unitKey, kind, showCheckbox = true }) => {
    const { t } = useI18n();
    const selected = useMessageUnitSelected(sessionId, unitKey);
    if (selected === null || !sessionId || !unitKey) return null;
    if (!showCheckbox) return <span hidden data-message-selection-mark={selected ? 'selected' : 'unselected'} />;
    return (
        <span
            data-message-selection-mark={selected ? 'selected' : 'unselected'}
            className={cn(
                'oc-message-selection-mark absolute z-10 flex size-5 items-center justify-center',
                kind === 'prompt' ? 'top-[0.9375rem]' : 'top-[0.1875rem]',
            )}
        >
            <Checkbox
                checked={selected}
                onChange={() => useMessageSelectionStore.getState().toggle(sessionId, unitKey)}
                ariaLabel={t(kind === 'prompt' ? 'chat.messageSelection.selectPrompt' : 'chat.messageSelection.selectAnswer')}
                className="size-4 min-h-4 min-w-4"
                iconClassName="[&_svg]:size-3"
            />
        </span>
    );
};
