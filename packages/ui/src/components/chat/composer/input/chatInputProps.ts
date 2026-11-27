import type { SpaceSendModel } from '@/lib/spaces/space-send';
export interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
    scrollToLatest?: () => void;
    active?: boolean;
    draftPresentationExiting?: boolean;
}

export type SubmitOptions = {
    queuedOnly?: boolean;
    spaceSendModel?: SpaceSendModel;
    queuedMessageId?: string;
    delivery?: 'steer';
    presetText?: string;
};
