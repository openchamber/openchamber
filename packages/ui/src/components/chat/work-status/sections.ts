import { z } from 'zod';

import type { I18nKey } from '@/lib/i18n/messages/en';

/**
 * Every section the work-status panel can render, in default display order.
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
  'telemetry',
  'subagents',
  'mcp',
  'pinned',
  'contextSources',
] as const;

export type WorkStatusSectionId = (typeof WORK_STATUS_SECTION_IDS)[number];

export const WORK_STATUS_SECTION_LABEL_KEYS = {
  session: 'chat.workStatus.section.session',
  repository: 'chat.workStatus.section.project',
  usage: 'chat.workStatus.section.usage',
  telemetry: 'chat.workStatus.section.telemetry',
  subagents: 'chat.workStatus.section.subagents',
  mcp: 'chat.workStatus.section.mcp',
  pinned: 'chat.workStatus.section.pinned',
  contextSources: 'chat.workStatus.section.contextBreakdown',
} as const satisfies Record<WorkStatusSectionId, I18nKey>;

/**
 * A section contributed by an installed extension (`contributes.statusSection`),
 * keyed by its extension id. Persisted next to the built-in ids.
 */
export type ExtensionSectionId = `ext:${string}`;

/** Any id the panel can place: a built-in section or an extension's. */
export type WorkStatusPanelSectionId = WorkStatusSectionId | ExtensionSectionId;

const EXTENSION_SECTION_ID = /^ext:[a-z][a-z0-9-]*$/;

export const extensionSectionId = (guestId: string): ExtensionSectionId => `ext:${guestId}`;

export const isExtensionSectionId = (value: string): value is ExtensionSectionId => EXTENSION_SECTION_ID.test(value);

// Extension ids are kept even when that extension is not installed right now:
// the catalog loads after settings, and a paused or reinstalled extension
// should come back where the user put it.
const storedSectionIdSchema = z.union([
  z.enum(WORK_STATUS_SECTION_IDS),
  z.templateLiteral(['ext:', z.string().regex(/^[a-z][a-z0-9-]*$/)]),
]);

const readStoredSectionId = (value: unknown): WorkStatusPanelSectionId | null => {
  const parsed = storedSectionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Preserve chosen positions, discard obsolete ids, and append newly added built-in sections. */
export const sanitizeWorkStatusSectionOrder = (value: readonly string[] | null | undefined): WorkStatusPanelSectionId[] => {
  const ordered = new Set<WorkStatusPanelSectionId>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = readStoredSectionId(entry);
      if (id) ordered.add(id);
    }
  }
  for (const id of WORK_STATUS_SECTION_IDS) ordered.add(id);
  return [...ordered];
};

/**
 * What the panel and the sections dialog show: the saved order with sections
 * of extensions that are not available here left out, and available ones the
 * saved order does not know appended in the order given.
 */
export const resolveWorkStatusSectionOrder = (
  stored: readonly string[] | null | undefined,
  extensionIds: readonly ExtensionSectionId[],
): WorkStatusPanelSectionId[] => {
  const available = new Set<string>(extensionIds);
  const order = sanitizeWorkStatusSectionOrder(stored).filter((id) => !isExtensionSectionId(id) || available.has(id));
  const placed = new Set<string>(order);
  for (const id of extensionIds) {
    if (!placed.has(id)) order.push(id);
  }
  return order;
};

/**
 * Hidden sections are stored, not visible ones. Every section is on by default.
 */
export const isWorkStatusSectionVisible = (
  hidden: readonly string[] | null | undefined,
  id: WorkStatusPanelSectionId,
): boolean => !hidden?.includes(id);

/**
 * True when every section the panel could show appears in the hidden set.
 *
 * Uses `.every()` instead of a length comparison so that stale ids left over
 * from a removed section cannot inflate the count past the current list length.
 */
export const areAllWorkStatusSectionsHidden = (
  hidden: readonly string[] | null | undefined,
  extensionIds: readonly ExtensionSectionId[] = [],
): boolean =>
  hidden != null
  && WORK_STATUS_SECTION_IDS.every((id) => hidden.includes(id))
  && extensionIds.every((id) => hidden.includes(id));

export const getWorkStatusPanelPresentation = ({
  visible,
  contentMounted,
  renderedSections,
  allSectionsHidden,
}: {
  visible: boolean;
  contentMounted: boolean;
  renderedSections: number;
  allSectionsHidden: boolean;
}): { interactive: boolean; showEmptyState: boolean } => ({
  interactive: visible && (renderedSections > 0 || allSectionsHidden),
  showEmptyState: contentMounted && allSectionsHidden,
});

export const sanitizeWorkStatusHiddenSections = (value: unknown, explicit = true): WorkStatusPanelSectionId[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<WorkStatusPanelSectionId>();
  for (const entry of value) {
    const id = readStoredSectionId(entry);
    if (id) seen.add(id);
  }
  // Older clients hid telemetry automatically until the user chose a list.
  if (!explicit) seen.delete('telemetry');
  return [...seen];
};
