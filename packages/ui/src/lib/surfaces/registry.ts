import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import {
  isPluginContextPanelMode,
  type ContextPanelMode,
} from '@/lib/surfaces/modes';

export type BuiltInContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'linear'
  | 'diff'
  | 'walkthrough'
  | 'terminal'
  | 'plan'
  | 'notes'
  | 'context'
  | 'browser'
  | 'chat';

export type ContextSurfaceId = BuiltInContextSurfaceId | `plugin:${string}`;

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  /** The context panel tab mode this surface activates. 1:1 in the current model. */
  mode: ContextPanelMode;
  icon: IconName;
  /** Authenticated package SVG for a guest rail mark. Prefer over `icon` when set. */
  iconSrc?: string;
  /** Guest-provided name. When set, the rail prefers this over `labelKey`. */
  label?: string;
  labelKey: I18nKey;
  /**
   * 'always' surfaces can be opened empty from the rail.
   * 'has-content' surfaces are content-driven: they need an existing tab of
   * their mode (a split session, a diff to show) and stay hidden on the rail
   * until one exists.
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
    id: 'linear',
    descriptionKey: 'contextRail.surface.linear.description',
    defaultWidthFraction: 0.45,
    mode: 'linear',
    icon: 'linear',
    labelKey: 'contextPanel.mode.linear',
    availability: 'always',
  },
  {
    id: 'editor',
    descriptionKey: 'contextRail.surface.editor.description',
    defaultWidthFraction: 3 / 5,
    mode: 'file',
    icon: 'file-edit',
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
    // As wide as the files surface: this panel now carries a sidebar and a
    // content column, and a third of the window leaves the content column too
    // narrow to read a note in.
    defaultWidthFraction: 3 / 5,
    mode: 'notes',
    icon: 'book-marked',
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

// Tablet width and up: below this the walkthrough cannot show a stop and its
// code side by side, which is the whole point of the surface.
export const WALKTHROUGH_MIN_WIDTH = 768;

export const getContextSurfaceWidthFraction = (mode: ContextPanelMode): number => {
  if (isPluginContextPanelMode(mode)) return 0.45;
  return FRACTION_BY_MODE.get(mode) ?? 1 / 2;
};

const isKnownSurfaceId = (value: string, byId: ReadonlyMap<string, ContextSurfaceDescriptor>): boolean => {
  return byId.has(value);
};

/**
 * Applies a persisted user reorder on top of the default registry order:
 * unknown ids are dropped, missing surfaces are appended in default order.
 */
export const sortContextSurfaces = (
  railOrder: readonly string[],
  extras: readonly ContextSurfaceDescriptor[] = [],
): ContextSurfaceDescriptor[] => {
  const all = extras.length === 0 ? CONTEXT_SURFACES : [...CONTEXT_SURFACES, ...extras];
  const byId = new Map<string, ContextSurfaceDescriptor>(all.map((surface) => [surface.id, surface]));
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<string>();

  for (const id of railOrder) {
    if (!isKnownSurfaceId(id, byId) || seen.has(id)) {
      continue;
    }
    const surface = byId.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of all) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  return ordered;
};

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  /** Surfaces the user chose to hide from the rail (and from the digit
      shortcuts, which share this filter). */
  hiddenSurfaces?: readonly string[];
  planModeEnabled: boolean;
  isVSCode: boolean;
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode }[];
  /** Linear's rail icon stays off until a workspace is connected. */
  linearConnected: boolean;
  /** The pull-request rail icon stays off until GitHub is connected (OAuth
      or a detected `gh` CLI login). GitHub is connected from Settings, so
      hiding the surface removes no entry point. */
  githubConnected: boolean;
  /** Installed guest panels. Empty on VS Code and when the catalog has not
      loaded or failed. */
  extras?: readonly ContextSurfaceDescriptor[];
};

/**
 * The context panel rail's visible, user-ordered surfaces. Shared by the rail
 * (for rendering and number badges) and the global surface-switch shortcut so
 * both agree on which surface each digit maps to.
 *
 * Content-driven surfaces are hidden (not disabled) until content exists; an
 * existing tab keeps them visible even if the content source went away.
 */
export const getVisibleContextRailSurfaces = (options: VisibleRailSurfacesOptions): ContextSurfaceDescriptor[] => {
  return sortContextSurfaces(options.railOrder, options.extras).filter((surface) => {
    if (options.hiddenSurfaces?.includes(surface.id)) {
      return false;
    }
    if (isPluginContextPanelMode(surface.mode) && options.isVSCode) {
      return false;
    }
    if (surface.id === 'plan' && !options.planModeEnabled) {
      return false;
    }
    // The walkthrough needs room for a stop list beside real code, and its
    // diffs come from OpenChamber's Git routes, which VS Code does not serve.
    if (surface.id === 'walkthrough' && (options.isVSCode || options.screenWidth < WALKTHROUGH_MIN_WIDTH)) {
      return false;
    }
    // VS Code already is an editor with a browser next to it. What OpenChamber
    // could add there is a bare frame: no annotation, no agent control, no
    // remote dev servers — all of which need a Chromium host the extension does
    // not have. Offering the surface anyway would promise the panel people see
    // on the desktop.
    if (surface.id === 'browser' && options.isVSCode) {
      return false;
    }
    if (surface.id === 'linear' && !options.linearConnected) {
      return false;
    }
    if (surface.id === 'pr' && !options.githubConnected) {
      return false;
    }
    if (surface.availability === 'has-content') {
      return options.tabs.some((tab) => tab.mode === surface.mode);
    }
    return true;
  });
};
