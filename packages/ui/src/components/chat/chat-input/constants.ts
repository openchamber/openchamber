import type { QueuedMessage } from '@/stores/messageQueueStore';
import type { Message } from '@opencode-ai/sdk/v2/client';

export const MAX_VISIBLE_TEXTAREA_LINES = 8;
export const EMPTY_QUEUE: QueuedMessage[] = [];
export const EMPTY_MESSAGES: Message[] = [];
export const FILE_MENTION_TOKEN = /^@[^\s]+$/;
// Single-line URL pasted over a selection becomes a markdown link.
export const PASTE_LINK_URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;
export const INLINE_SKILL_TOKEN_PATTERN = /(^|\s)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;
export const CHAT_DRAFT_PERSIST_DEBOUNCE_MS = 500;
export const COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH = 560;
export const VS_CODE_DROP_DATA_TYPES = [
    'CodeFiles',
    'codefiles',
    'application/vnd.code.tree',
    'application/vnd.code.tree.explorer',
    'text/uri-list',
    'text/plain',
];
export const FILE_URI_PREFIX = 'file://';
