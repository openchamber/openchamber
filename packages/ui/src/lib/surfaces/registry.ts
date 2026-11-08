import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import {
  isPluginContextPanelMode,
  type ContextPanelMode,
} from '@/lib/surfaces/modes';

type BuiltInContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'diff'
  | 'walkthrough'
  | 'terminal'
  | 'notes'
  | 'context'
  | 'browser'
  | 'workflows'
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
};

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    descriptionKey: 'contextRail.surface.context.description',
    mode: 'context',
    icon: 'donut-chart-fill',
    labelKey: 'contextPanel.mode.context',
    availability: 'always',
  },
  {
    id: 'git',
    descriptionKey: 'contextRail.surface.git.description',
    mode: 'git',
    icon: 'git-branch',
    labelKey: 'layout.rightSidebar.git',
    availability: 'always',
  },
  {
    id: 'pr',
    descriptionKey: 'contextRail.surface.pr.description',
    mode: 'pr',
    icon: 'github',
    labelKey: 'contextPanel.mode.pr',
    availability: 'always',
  },
  {
    id: 'diff',
    descriptionKey: 'contextRail.surface.diff.description',
    mode: 'diff',
    icon: 'arrow-left-right',
    labelKey: 'contextPanel.mode.diff',
    availability: 'always',
  },
  {
    id: 'walkthrough',
    descriptionKey: 'contextRail.surface.walkthrough.description',
    mode: 'walkthrough',
    icon: 'route',
    labelKey: 'contextPanel.mode.walkthrough',
    availability: 'always',
  },
  {
    id: 'editor',
    descriptionKey: 'contextRail.surface.editor.description',
    mode: 'file',
    icon: 'file-edit',
    labelKey: 'contextPanel.mode.files',
    availability: 'always',
  },
  {
    id: 'terminal',
    descriptionKey: 'contextRail.surface.terminal.description',
    mode: 'terminal',
    icon: 'terminal-box',
    labelKey: 'layout.mainTab.terminal',
    availability: 'always',
  },
  {
    id: 'browser',
    descriptionKey: 'contextRail.surface.browser.description',
    mode: 'browser',
    icon: 'global',
    labelKey: 'contextPanel.mode.browser',
    availability: 'always',
  },
  {
    id: 'notes',
    descriptionKey: 'contextRail.surface.notes.description',
    mode: 'notes',
    icon: 'book-marked',
    labelKey: 'contextRail.surface.notes',
    availability: 'always',
  },
  {
    id: 'workflows',
    descriptionKey: 'contextRail.surface.workflows.description',
    mode: 'workflows',
    icon: 'flow-chart',
    labelKey: 'contextPanel.mode.workflows',
    availability: 'always',
  },
  {
    id: 'chat',
    descriptionKey: 'contextRail.surface.chat.description',
    mode: 'chat',
    icon: 'chat-4',
    labelKey: 'contextPanel.mode.chat',
    availability: 'has-content',
  },
];

// Tablet width and up: below this the walkthrough cannot show a stop and its
// code side by side, which is the whole point of the surface.
export const WALKTHROUGH_MIN_WIDTH = 768;

/**
 * The rail's groups, drawn apart by a divider: the session's context, its
 * changes, the tools that work on the project, the session's workspace, and
 * installed extensions.
 */
type ContextSurfaceGroup = 'context' | 'changes' | 'tools' | 'workspace' | 'extensions';

const BUILT_IN_SURFACE_GROUPS = {
  context: 'context',
  git: 'changes',
  pr: 'changes',
  diff: 'changes',
  walkthrough: 'changes',
  editor: 'tools',
  terminal: 'tools',
  browser: 'tools',
  notes: 'workspace',
  workflows: 'workspace',
  chat: 'workspace',
} satisfies Record<BuiltInContextSurfaceId, ContextSurfaceGroup>;

const isBuiltInSurfaceId = (id: ContextSurfaceId): id is BuiltInContextSurfaceId => Object.hasOwn(BUILT_IN_SURFACE_GROUPS, id);

export const contextSurfaceGroup = (surface: Pick<ContextSurfaceDescriptor, 'id' | 'mode'>): ContextSurfaceGroup => (
  !isPluginContextPanelMode(surface.mode) && isBuiltInSurfaceId(surface.id)
    ? BUILT_IN_SURFACE_GROUPS[surface.id]
    : 'extensions'
);

const isKnownSurfaceId = (value: string, byId: ReadonlyMap<string, ContextSurfaceDescriptor>): boolean => {
  return byId.has(value);
};

/**
 * Applies a persisted user reorder on top of the default registry order:
 * unknown ids are dropped, missing surfaces are appended in default order.
 * Surfaces then gather into their groups: a group stands where its first
 * surface stands, and its surfaces keep their order inside it. So moving a
 * group's surface ahead of another group moves the whole group, and a saved
 * order from before groups existed still reads as groups.
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

  const groupOrder: ContextSurfaceGroup[] = [];
  for (const surface of ordered) {
    const group = contextSurfaceGroup(surface);
    if (!groupOrder.includes(group)) groupOrder.push(group);
  }
  return groupOrder.flatMap((group) => ordered.filter((surface) => contextSurfaceGroup(surface) === group));
};

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  /** Surfaces the user chose to hide from the rail (and from the digit
      shortcuts, which share this filter). */
  hiddenSurfaces?: readonly string[];
  isVSCode: boolean;
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode; targetPath?: string | null }[];
  /** The Tracker rail icon stays off until a GitHub or GitLab account is
      connected (OAuth, a token, or a detected `gh`/`glab` login), or an item
      such as a Linear issue is open in it. Accounts are connected from
      Settings, so hiding the surface removes no entry point. */
  sourceControlConnected: boolean;
  /** The Workflows icon shows while the session on screen has a workflow run,
      or a Workflows tab is open, and never in a build without workflows. Runs
      start from the chat, so hiding it removes no entry point. */
  workflowsShown: boolean;
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
    if (surface.id === 'pr' && !options.sourceControlConnected
      && !options.tabs.some((tab) => tab.mode === 'pr' && tab.targetPath)) {
      return false;
    }
    if (surface.id === 'workflows' && (options.isVSCode || !options.workflowsShown)) {
      return false;
    }
    if (surface.availability === 'has-content') {
      return options.tabs.some((tab) => tab.mode === surface.mode);
    }
    return true;
  });
};
