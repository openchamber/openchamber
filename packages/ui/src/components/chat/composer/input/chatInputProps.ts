export interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
    // Queued sends do not create a user row (the queue delivers later), so
    // the anchor-arming scrollToBottom is wrong for them; this returns the
    // viewport to the live edge instead.
    scrollToLatest?: () => void;
    active?: boolean;
    draftPresentationExiting?: boolean;
}

export type SubmitOptions = {
    queuedOnly?: boolean;
    queuedMessageId?: string;
    delivery?: 'steer';
    /** Submit this text instead of the composer input. Used by preset
        starter chips: on mobile the collapsed pill has no mounted textarea,
        so the DOM-first input snapshot would read empty content. */
    presetText?: string;
};
