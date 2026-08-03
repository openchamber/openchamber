import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import type { ContextPanelMode } from '@/stores/useUIStore';

export type ContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'diff'
  | 'walkthrough'
  | 'terminal'
  | 'plan'
  | 'notes'
  | 'context'
  | 'browser'
  | 'preview'
  | 'chat';

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  /** The context panel tab mode this surface activates. 1:1 in the current model. */
  mode: ContextPanelMode;
  icon: IconName;
  labelKey: I18nKey;
  /**
   * 'always' surfaces can be opened empty from the rail.
   * 'has-content' surfaces are content-driven: they need an existing tab of
   * their mode (a preview URL emitted, a split session) and stay hidden on
   * the rail until one exists.
   */
  availability: 'always' | 'has-content';
  /** Short tooltip explanation shown on the rail. */
  descriptionKey: I18nKey;
  /**
   * Default panel width as a fraction of the available content area, used
   * until the user manually resizes this surface.
   */
  defaultWidthFraction: number;
};

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    descriptionKey: 'contextRail.surface.context.description',
    defaultWidthFraction: 0.45,
    mode: 'context',
    icon: 'donut-chart-fill',
    labelKey: 'contextPanel.mode.context',
    availability: 'always',
  },
  {
    id: 'git',
    descriptionKey: 'contextRail.surface.git.description',
    defaultWidthFraction: 2 / 5,
    mode: 'git',
    icon: 'git-branch',
    labelKey: 'layout.rightSidebar.git',
    availability: 'always',
  },
  {
    id: 'pr',
    descriptionKey: 'contextRail.surface.pr.description',
    defaultWidthFraction: 0.45,
    mode: 'pr',
    icon: 'github',
    labelKey: 'contextPanel.mode.pr',
    availability: 'always',
  },
  {
    id: 'diff',
    descriptionKey: 'contextRail.surface.diff.description',
    defaultWidthFraction: 3 / 5,
    mode: 'diff',
    icon: 'arrow-left-right',
    labelKey: 'contextPanel.mode.diff',
    availability: 'always',
  },
  {
    id: 'walkthrough',
    descriptionKey: 'contextRail.surface.walkthrough.description',
    defaultWidthFraction: 3 / 5,
    mode: 'walkthrough',
    icon: 'route',
    labelKey: 'contextPanel.mode.walkthrough',
    availability: 'always',
  },
  {
    id: 'editor',
    descriptionKey: 'contextRail.surface.editor.description',
    defaultWidthFraction: 3 / 5,
    mode: 'file',
    icon: 'braces',
    labelKey: 'contextPanel.mode.files',
    availability: 'always',
  },
  {
    id: 'terminal',
    descriptionKey: 'contextRail.surface.terminal.description',
    defaultWidthFraction: 3 / 5,
    mode: 'terminal',
    icon: 'terminal-box',
    labelKey: 'layout.mainTab.terminal',
    availability: 'always',
  },
  {
    id: 'notes',
    descriptionKey: 'contextRail.surface.notes.description',
    defaultWidthFraction: 1 / 3,
    mode: 'notes',
    icon: 'sticky-note',
    labelKey: 'contextRail.surface.notes',
    availability: 'always',
  },
  {
    id: 'plan',
    descriptionKey: 'contextRail.surface.plan.description',
    defaultWidthFraction: 0.45,
    mode: 'plan',
    icon: 'file-text',
    labelKey: 'contextPanel.mode.plan',
    availability: 'always',
  },
  {
    id: 'browser',
    descriptionKey: 'contextRail.surface.browser.description',
    defaultWidthFraction: 0.45,
    mode: 'browser',
    icon: 'global',
    labelKey: 'contextPanel.mode.browser',
    availability: 'always',
  },
  {
    id: 'preview',
    descriptionKey: 'contextRail.surface.preview.description',
    defaultWidthFraction: 0.45,
    mode: 'preview',
    icon: 'window',
    labelKey: 'contextPanel.mode.preview',
    availability: 'has-content',
  },
  {
    id: 'chat',
    descriptionKey: 'contextRail.surface.chat.description',
    defaultWidthFraction: 0.45,
    mode: 'chat',
    icon: 'chat-4',
    labelKey: 'contextPanel.mode.chat',
    availability: 'has-content',
  },
];

const SURFACE_BY_ID = new Map(CONTEXT_SURFACES.map((surface) => [surface.id, surface]));
const FRACTION_BY_MODE = new Map(CONTEXT_SURFACES.map((surface) => [surface.mode, surface.defaultWidthFraction]));

export const getContextSurfaceWidthFraction = (mode: ContextPanelMode): number => {
  return FRACTION_BY_MODE.get(mode) ?? 1 / 2;
};

const isContextSurfaceId = (value: unknown): value is ContextSurfaceId => {
  return typeof value === 'string' && SURFACE_BY_ID.has(value as ContextSurfaceId);
};

/**
 * Applies a persisted user reorder on top of the default registry order:
 * unknown ids are dropped, missing surfaces are appended in default order.
 */
export const sortContextSurfaces = (railOrder: readonly string[]): ContextSurfaceDescriptor[] => {
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<ContextSurfaceId>();

  for (const id of railOrder) {
    if (!isContextSurfaceId(id) || seen.has(id)) {
      continue;
    }
    const surface = SURFACE_BY_ID.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of CONTEXT_SURFACES) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  return ordered;
};
