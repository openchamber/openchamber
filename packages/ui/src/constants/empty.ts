import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

/**
 * Pre-allocated frozen empty values for use as stable references in selectors
 * and fallback positions. Using these instead of inline `[] as X[]` or `{}`
 * prevents unnecessary re-renders caused by new reference creation.
 */

export const EMPTY_OBJECT = Object.freeze({}) as Record<string, never>;
export const EMPTY_ARRAY = Object.freeze([]) as readonly never[];

/** Typed helper — returns the single frozen empty array cast to `readonly T[]`. */
export function emptyArray<T>(): readonly T[] {
    return EMPTY_ARRAY as unknown as readonly T[];
}

// Domain-specific typed empty arrays used across multiple files.
export const EMPTY_MESSAGES: Message[] = EMPTY_ARRAY as unknown as Message[];
export const EMPTY_PARTS: Part[] = EMPTY_ARRAY as unknown as Part[];
export const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = EMPTY_ARRAY as unknown as PermissionRequest[];
export const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = EMPTY_ARRAY as unknown as QuestionRequest[];
