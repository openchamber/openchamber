/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Part } from "@/lib/opencode/model";

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
