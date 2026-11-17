export interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
    scrollToLatest?: () => void;
    active?: boolean;
    draftPresentationExiting?: boolean;
}

export type SubmitOptions = {
    queuedOnly?: boolean;
    queuedMessageId?: string;
    delivery?: 'steer';
    presetText?: string;
};
