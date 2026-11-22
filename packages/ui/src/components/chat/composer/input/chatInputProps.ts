import type { GoalSubmitChoice } from '@/lib/goalWriter';

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
    /** The goal writer's outcome for this send; set when the writer dialog sends again. */
    goal?: GoalSubmitChoice;
};
