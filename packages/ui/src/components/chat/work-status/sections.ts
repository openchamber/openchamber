import { z } from 'zod';

import type { I18nKey } from '@/lib/i18n/messages/en';

export const WORK_STATUS_SECTION_IDS = [
  'session',
  'repository',
  'usage',
  'contextSources',
  'telemetry',
  'subagents',
  'tasks',
  'workflows',
  'mcp',
  'pinned',
] as const;

export type WorkStatusSectionId = (typeof WORK_STATUS_SECTION_IDS)[number];

export const WORK_STATUS_SECTION_LABEL_KEYS = {
  session: 'chat.workStatus.section.session',
  repository: 'chat.workStatus.section.project',
  usage: 'chat.workStatus.section.usage',
  telemetry: 'chat.workStatus.section.telemetry',
  subagents: 'chat.workStatus.section.subagents',
  tasks: 'chat.workStatus.section.tasks',
  workflows: 'chat.workStatus.section.workflows',
  mcp: 'chat.workStatus.section.mcp',
  pinned: 'chat.workStatus.section.pinned',
  contextSources: 'chat.workStatus.section.contextBreakdown',
} as const satisfies Record<WorkStatusSectionId, I18nKey>;

export type ExtensionSectionId = `ext:${string}`;

export type WorkStatusPanelSectionId = WorkStatusSectionId | ExtensionSectionId;

const EXTENSION_SECTION_ID = /^ext:[a-z][a-z0-9-]*$/;

export const extensionSectionId = (guestId: string): ExtensionSectionId => `ext:${guestId}`;

export const isExtensionSectionId = (value: string): value is ExtensionSectionId => EXTENSION_SECTION_ID.test(value);

const storedSectionIdSchema = z.union([
  z.enum(WORK_STATUS_SECTION_IDS),
  z.templateLiteral(['ext:', z.string().regex(/^[a-z][a-z0-9-]*$/)]),
]);

const readStoredSectionId = (value: unknown): WorkStatusPanelSectionId | null => {
  const parsed = storedSectionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const DEFAULT_ORDER_WITH_CONTEXT_SOURCES_LAST: readonly WorkStatusPanelSectionId[] = [
  'session', 'repository', 'usage', 'subagents', 'mcp', 'pinned', 'contextSources',
];

const isDefaultOrderWithContextSourcesLast = (order: readonly WorkStatusPanelSectionId[]): boolean => {
  const placed = order.filter((id) => id !== 'telemetry' && id !== 'workflows' && id !== 'tasks');
  return placed.length === DEFAULT_ORDER_WITH_CONTEXT_SOURCES_LAST.length
    && placed.every((id, index) => id === DEFAULT_ORDER_WITH_CONTEXT_SOURCES_LAST[index]);
};

const PLACED_AFTER = new Map<WorkStatusSectionId, WorkStatusSectionId>([['tasks', 'subagents']]);

export const sanitizeWorkStatusSectionOrder = (
  value: readonly string[] | null | undefined,
  arranged = true,
): WorkStatusPanelSectionId[] => {
  const ordered = new Set<WorkStatusPanelSectionId>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      const id = readStoredSectionId(entry);
      if (id) ordered.add(id);
    }
  }
  const order = [...ordered];
  for (const id of WORK_STATUS_SECTION_IDS) {
    if (ordered.has(id)) continue;
    const after = PLACED_AFTER.get(id);
    const at = after ? order.indexOf(after) : -1;
    if (at === -1) order.push(id);
    else order.splice(at + 1, 0, id);
    ordered.add(id);
  }
  if (arranged || !isDefaultOrderWithContextSourcesLast(order)) return order;
  const moved: WorkStatusPanelSectionId[] = order.filter((id) => id !== 'contextSources');
  moved.splice(moved.indexOf('usage') + 1, 0, 'contextSources');
  return moved;
};

export const resolveWorkStatusSectionOrder = (
  stored: readonly string[] | null | undefined,
  extensionIds: readonly ExtensionSectionId[],
  unavailable: readonly WorkStatusSectionId[] = [],
): WorkStatusPanelSectionId[] => {
  const available = new Set<string>(extensionIds);
  const missing = new Set<string>(unavailable);
  const order = sanitizeWorkStatusSectionOrder(stored)
    .filter((id) => !missing.has(id) && (!isExtensionSectionId(id) || available.has(id)));
  const placed = new Set<string>(order);
  for (const id of extensionIds) {
    if (!placed.has(id)) order.push(id);
  }
  return order;
};

export const isWorkStatusSectionVisible = (
  hidden: readonly string[] | null | undefined,
  id: WorkStatusPanelSectionId,
): boolean => !hidden?.includes(id);

export const areAllWorkStatusSectionsHidden = (
  hidden: readonly string[] | null | undefined,
  extensionIds: readonly ExtensionSectionId[] = [],
  unavailable: readonly WorkStatusSectionId[] = [],
): boolean =>
  hidden != null
  && WORK_STATUS_SECTION_IDS.every((id) => unavailable.includes(id) || hidden.includes(id))
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
  if (!explicit) seen.delete('telemetry');
  return [...seen];
};
