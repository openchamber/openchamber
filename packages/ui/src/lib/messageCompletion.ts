/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Part } from "@opencode-ai/sdk/v2";

interface MessageInfo {
    id: string;
    role: string;
    time?: {
        created?: number;
        completed?: number;
    };
    status?: string;
    streaming?: boolean;
    finish?: string;
}

export interface MessageRecord {
    info: MessageInfo & Record<string, any>;
    parts: Part[];
}
