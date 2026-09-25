import type { Message } from '@/lib/opencode/model';

/** Roles `TimelineNotice` owns; the rest belong to `ChatMessage` or nothing. */
const NOTICE_ROLES = new Set<Message['role']>(['compaction', 'shell']);

/**
 * Roles the timeline never shows.
 *
 * `synthetic` is prompt plumbing: the items the user attached in the composer
 * are re-attached to the user message they belong to (see
 * `attachSyntheticContext`), and everything else a plugin injects is machinery
 * the user did not write. `system`, `skill` and `location-switched` carry no
 * decision the user has to see. `agent-switched` and `model-switched` say what
 * the composer already shows.
 */
const SKIPPED_ROLES = new Set<Message['role']>([
    'synthetic',
    'system',
    'skill',
    'location-switched',
    'idle',
    'agent-switched',
    'model-switched',
]);

export const isTimelineNoticeRole = (role: Message['role']): boolean => NOTICE_ROLES.has(role);

export const isSkippedTimelineRole = (role: Message['role']): boolean => SKIPPED_ROLES.has(role);
