import type React from 'react';
import type { SubmitOptions } from './chatInputProps';

export type ComposerSendHandlers = {
    handleSubmitRef: React.RefObject<(options?: SubmitOptions) => Promise<void>>;
    handleQueueMessageRef: React.RefObject<() => Promise<void>>;
};
