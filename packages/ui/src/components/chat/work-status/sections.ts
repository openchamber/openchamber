import type { I18nKey } from '@/lib/i18n/messages/en';

/**
 * Every section the work-status panel can render, in display order.
 *
 * One list drives both the panel and its settings dialog, so a section cannot
 * exist in the panel without being switchable, or appear in the dialog without
 * existing.
 *
 * The ids are persisted in user settings — renaming one silently resets that
 * user's choice for it.
 */
export const WORK_STATUS_SECTION_IDS = [
  'session',
  'repository',
  'usage',
  'subagents',
  'tasks',
  'mcp',
  'pinned',
  'contextSources',
] as const;

type WorkStatusSectionId = (typeof WORK_STATUS_SECTION_IDS)[number];

export const WORK_STATUS_SECTION_LABEL_KEYS: Record<WorkStatusSectionId, I18nKey> = {
  session: 'chat.workStatus.section.session',
  repository: 'chat.workStatus.section.repository',
  usage: 'chat.workStatus.section.usage',
  subagents: 'chat.workStatus.section.subagents',
  tasks: 'chat.workStatus.section.tasks',
  mcp: 'chat.workStatus.section.mcp',
  pinned: 'chat.workStatus.section.pinned',
  contextSources: 'chat.workStatus.section.contextBreakdown',
};

const KNOWN_IDS = new Set<string>(WORK_STATUS_SECTION_IDS);

const isWorkStatusSectionId = (value: unknown): value is WorkStatusSectionId =>
  typeof value === 'string' && KNOWN_IDS.has(value);

/**
 * Hidden sections are stored, not visible ones: everything is on by default, so
 * an empty list means "the user has changed nothing" and a section added later
 * appears without touching anyone's saved settings.
 */
export const isWorkStatusSectionVisible = (
  hidden: readonly string[] | null | undefined,
  id: WorkStatusSectionId,
): boolean => !hidden?.includes(id);

/**
 * True when every known section id appears in the hidden set.
 *
 * Uses `.every()` instead of a length comparison so that stale ids left over
 * from a removed section cannot inflate the count past the current list length.
 */
export const areAllWorkStatusSectionsHidden = (
  hidden: readonly string[] | null | undefined,
): boolean =>
  hidden != null && WORK_STATUS_SECTION_IDS.every((id) => hidden.includes(id));

export const sanitizeWorkStatusHiddenSections = (value: unknown): WorkStatusSectionId[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<WorkStatusSectionId>();
  for (const entry of value) {
    if (isWorkStatusSectionId(entry)) seen.add(entry);
  }
  return [...seen];
};
