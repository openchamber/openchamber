import type { Message } from '@/lib/opencode/model';

/** Roles `TimelineNotice` owns; the rest belong to `ChatMessage` or nothing. */
const NOTICE_ROLES = new Set<Message['role']>(['compaction', 'shell', 'synthetic']);

/**
 * Roles the timeline never shows.
 *
 * `synthetic` is not skipped wholesale: it sits in NOTICE_ROLES and
 * `TimelineNotice` renders it only when it carries a `description`. The items
 * the user attached in the composer are re-attached to the user message they
 * belong to (see `attachSyntheticContext`) and description-less injections are
 * machinery the user did not write, but a plugin that labels its injection
 * ("retry round 3 · internal marker") is reporting state the user needs to see.
 * `system`, `skill` and `location-switched` carry no decision the user has to
 * see. `agent-switched` and `model-switched` say what the composer already
 * shows.
 */
const SKIPPED_ROLES = new Set<Message['role']>([
    'system',
    'skill',
    'location-switched',
    'idle',
    'agent-switched',
    'model-switched',
]);

export const isTimelineNoticeRole = (role: Message['role']): boolean => NOTICE_ROLES.has(role);

export const isSkippedTimelineRole = (role: Message['role']): boolean => SKIPPED_ROLES.has(role);
