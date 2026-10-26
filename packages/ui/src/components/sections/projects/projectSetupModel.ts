/**
 * What the project page edits in a project's setup, and how each edit maps
 * onto the two files behind it: the team's `.openchamber/project.json` in the
 * repo (`shared`) and the user's own config (`personal`).
 *
 * The page shows one list per kind with every entry marked by where it lives,
 * so an edit writes the file the entry is in, and a move between the files is
 * a write to the destination followed by a removal from the source. The
 * server merges actions by id with the personal copy winning, so a move whose
 * second write fails leaves the entry visible once rather than losing it.
 */

import type { IconName } from '@/components/icon/icons';
import type {
  OpenChamberProjectAction,
  ProjectSetup,
  ProjectSetupSource,
} from '@/lib/openchamberConfig';
import { PROJECT_ACTION_ICON_MAP } from '@/lib/projectActions';

const ACTION_ICONS_BY_KEY: Readonly<Record<string, IconName>> = PROJECT_ACTION_ICON_MAP;

/** An action without an icon, or with one this build does not know, shows the play icon. */
export const projectActionIconName = (icon: string | null | undefined): IconName => ACTION_ICONS_BY_KEY[icon || 'play'] ?? 'play';

export type ProjectActionPlatform = NonNullable<OpenChamberProjectAction['platforms']>[number];

/** Operating system names, shown as they are in every language. */
export const PROJECT_ACTION_PLATFORMS: Array<{ value: ProjectActionPlatform; label: string }> = [
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
];

export type ProjectActionEntry = {
  action: OpenChamberProjectAction;
  source: ProjectSetupSource;
  /** A team action the user hid from their own run menu. */
  hidden: boolean;
};

/**
 * Every action the user can see or bring back: the team's (a personal action
 * with the same id overrides it, so it shows once, as personal) then their own.
 */
export const listProjectActions = (setup: ProjectSetup): ProjectActionEntry[] => {
  const personalIds = new Set(setup.personal.projectActions.map((action) => action.id));
  const hidden = new Set(setup.personal.hiddenSharedActionIds);
  return [
    ...setup.shared.projectActions
      .filter((action) => !personalIds.has(action.id))
      .map((action) => ({ action, source: 'shared' as const, hidden: hidden.has(action.id) })),
    ...setup.personal.projectActions.map((action) => ({ action, source: 'personal' as const, hidden: false })),
  ];
};

/** A file the team shares can be written only when it was read: a write replaces a broken file. */
export const canWriteShared = (setup: ProjectSetup): boolean => setup.shared.status !== 'invalid';

export type ProjectSetupWriters = {
  personalActions: (actions: OpenChamberProjectAction[]) => Promise<boolean>;
  sharedActions: (actions: OpenChamberProjectAction[]) => Promise<boolean>;
  hiddenSharedActionIds: (ids: string[]) => Promise<boolean>;
  personalCommands: (commands: string[]) => Promise<boolean>;
  sharedCommands: (commands: string[]) => Promise<boolean>;
};

const withoutSource = (action: OpenChamberProjectAction): OpenChamberProjectAction => {
  const copy = { ...action };
  delete copy.source;
  return copy;
};

const upsert = (actions: OpenChamberProjectAction[], action: OpenChamberProjectAction): OpenChamberProjectAction[] => {
  const clean = withoutSource(action);
  return actions.some((entry) => entry.id === clean.id)
    ? actions.map((entry) => (entry.id === clean.id ? clean : entry))
    : [...actions, clean];
};

const removeAction = (actions: OpenChamberProjectAction[], id: string): OpenChamberProjectAction[] => (
  actions.filter((entry) => entry.id !== id)
);

/**
 * Save `action` into `to`. `from` is where it lives now, or null for a new
 * one. Resolves false when a write failed; the caller reloads either way.
 */
export const saveProjectAction = async (
  setup: ProjectSetup,
  write: ProjectSetupWriters,
  action: OpenChamberProjectAction,
  from: ProjectSetupSource | null,
  to: ProjectSetupSource,
): Promise<boolean> => {
  const written = to === 'shared'
    ? await write.sharedActions(upsert(setup.shared.projectActions, action))
    : await write.personalActions(upsert(setup.personal.projectActions, action));
  if (!written || from === null || from === to) return written;
  return from === 'shared'
    ? write.sharedActions(removeAction(setup.shared.projectActions, action.id))
    : write.personalActions(removeAction(setup.personal.projectActions, action.id));
};

export const deleteProjectAction = async (
  setup: ProjectSetup,
  write: ProjectSetupWriters,
  entry: ProjectActionEntry,
): Promise<boolean> => {
  if (entry.source === 'personal') {
    return write.personalActions(removeAction(setup.personal.projectActions, entry.action.id));
  }
  if (!(await write.sharedActions(removeAction(setup.shared.projectActions, entry.action.id)))) return false;
  // Forgetting the hide of an action that no longer exists keeps the personal
  // file tidy; a failure here leaves a harmless stale id.
  if (entry.hidden) {
    await write.hiddenSharedActionIds(setup.personal.hiddenSharedActionIds.filter((id) => id !== entry.action.id));
  }
  return true;
};

export const setSharedActionHidden = (
  setup: ProjectSetup,
  write: ProjectSetupWriters,
  id: string,
  hidden: boolean,
): Promise<boolean> => {
  const rest = setup.personal.hiddenSharedActionIds.filter((entry) => entry !== id);
  return write.hiddenSharedActionIds(hidden ? [...rest, id] : rest);
};

type SetupCommandEntry = {
  command: string;
  source: ProjectSetupSource;
  /** Position in its own file's list. */
  index: number;
  /** A team command the user's "only my commands" mode leaves out. */
  skipped: boolean;
};

/** The commands in the order a new worktree runs them: the team's, then the user's. */
export const listSetupCommands = (setup: ProjectSetup): SetupCommandEntry[] => {
  const skipped = setup.personal.setupWorktreeMode === 'replace';
  return [
    ...setup.shared.setupWorktree.map((command, index) => ({ command, source: 'shared' as const, index, skipped })),
    ...setup.personal.setupWorktree.map((command, index) => ({ command, source: 'personal' as const, index, skipped: false })),
  ];
};

const commandsOf = (setup: ProjectSetup, source: ProjectSetupSource): string[] => (
  source === 'shared' ? setup.shared.setupWorktree : setup.personal.setupWorktree
);

const writeCommands = (write: ProjectSetupWriters, source: ProjectSetupSource, commands: string[]): Promise<boolean> => (
  source === 'shared' ? write.sharedCommands(commands) : write.personalCommands(commands)
);

/** Replace a command's text; empty text removes it. */
export const editSetupCommand = (
  setup: ProjectSetup,
  write: ProjectSetupWriters,
  entry: SetupCommandEntry,
  text: string,
): Promise<boolean> => {
  const next = text.trim();
  const commands = commandsOf(setup, entry.source);
  return writeCommands(
    write,
    entry.source,
    next ? commands.map((command, index) => (index === entry.index ? next : command)) : commands.filter((_command, index) => index !== entry.index),
  );
};

export const addSetupCommand = (setup: ProjectSetup, write: ProjectSetupWriters, text: string): Promise<boolean> => (
  write.personalCommands([...setup.personal.setupWorktree, text.trim()])
);

export const removeSetupCommand = (setup: ProjectSetup, write: ProjectSetupWriters, entry: SetupCommandEntry): Promise<boolean> => (
  editSetupCommand(setup, write, entry, '')
);

/** Move a command to the other file, appended to the end of its list there. */
export const moveSetupCommand = async (
  setup: ProjectSetup,
  write: ProjectSetupWriters,
  entry: SetupCommandEntry,
): Promise<boolean> => {
  const to: ProjectSetupSource = entry.source === 'shared' ? 'personal' : 'shared';
  if (!(await writeCommands(write, to, [...commandsOf(setup, to), entry.command]))) return false;
  return removeSetupCommand(setup, write, entry);
};
