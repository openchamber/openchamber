import { describe, expect, test } from 'bun:test';
import type { OpenChamberProjectAction, ProjectSetup } from '@/lib/openchamberConfig';
import {
  addSetupCommand,
  deleteProjectAction,
  editSetupCommand,
  listProjectActions,
  listSetupCommands,
  moveSetupCommand,
  saveProjectAction,
  setSharedActionHidden,
  type ProjectSetupWriters,
} from './projectSetupModel';

type SetupAction = ProjectSetup['personal']['projectActions'][number];

const action = (id: string, name = id): SetupAction => ({ id, name, command: `run ${id}` });

const setupWith = (options: {
  shared?: SetupAction[];
  personal?: SetupAction[];
  hidden?: string[];
  sharedCommands?: string[];
  personalCommands?: string[];
  replace?: boolean;
}): ProjectSetup => ({
  trust: { hash: null, trusted: true },
  setupWorktree: [],
  setupWorktreeWait: false,
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'ok',
    path: '.openchamber/project.json',
    setupWorktree: options.sharedCommands ?? [],
    setupWorktreeWait: null,
    projectActions: options.shared ?? [],
    draftStarters: [],
    plansDir: null,
  },
  personal: {
    setupWorktree: options.personalCommands ?? [],
    setupWorktreeWait: null,
    setupWorktreeMode: options.replace ? 'replace' : 'append',
    projectActions: options.personal ?? [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    hiddenSharedActionIds: options.hidden ?? [],
    sharedTrust: null,
  },
});

type Write = { file: keyof ProjectSetupWriters; value: Array<OpenChamberProjectAction | string> };

/** Writers that record every call in order; `fail` names the writer that reports failure. */
const recordingWriters = (fail?: keyof ProjectSetupWriters) => {
  const writes: Write[] = [];
  const writer = (file: keyof ProjectSetupWriters) => async (value: Array<OpenChamberProjectAction | string>) => {
    writes.push({ file, value });
    return file !== fail;
  };
  return {
    writes,
    write: {
      personalActions: writer('personalActions'),
      sharedActions: writer('sharedActions'),
      hiddenSharedActionIds: writer('hiddenSharedActionIds'),
      personalCommands: writer('personalCommands'),
      sharedCommands: writer('sharedCommands'),
    } satisfies ProjectSetupWriters,
  };
};

describe('listProjectActions', () => {
  test('lists team actions first, then personal ones, and shows a personal override once', () => {
    const setup = setupWith({ shared: [action('dev'), action('lint')], personal: [action('lint', 'My lint'), action('build')], hidden: ['dev'] });
    expect(listProjectActions(setup).map((entry) => [entry.action.name, entry.source, entry.hidden])).toEqual([
      ['dev', 'shared', true],
      ['My lint', 'personal', false],
      ['build', 'personal', false],
    ]);
  });
});

describe('saveProjectAction', () => {
  test('edits a team action in the repository file without copying it into personal settings', async () => {
    const setup = setupWith({ shared: [action('dev')] });
    const { writes, write } = recordingWriters();
    expect(await saveProjectAction(setup, write, { ...action('dev'), command: 'bun dev' }, 'shared', 'shared')).toBe(true);
    expect(writes).toEqual([{ file: 'sharedActions', value: [{ id: 'dev', name: 'dev', command: 'bun dev' }] }]);
  });

  test('moves a personal action to the team by writing the repository first, then removing it from personal', async () => {
    const setup = setupWith({ personal: [action('build'), action('test')] });
    const { writes, write } = recordingWriters();
    expect(await saveProjectAction(setup, write, action('build'), 'personal', 'shared')).toBe(true);
    expect(writes).toEqual([
      { file: 'sharedActions', value: [action('build')] },
      { file: 'personalActions', value: [action('test')] },
    ]);
  });

  test('a failed write to the destination leaves the source untouched', async () => {
    const setup = setupWith({ shared: [action('dev')] });
    const { writes, write } = recordingWriters('personalActions');
    expect(await saveProjectAction(setup, write, action('dev'), 'shared', 'personal')).toBe(false);
    expect(writes.map((entry) => entry.file)).toEqual(['personalActions']);
  });

  test('a new action is appended to personal settings', async () => {
    const setup = setupWith({ personal: [action('build')] });
    const { writes, write } = recordingWriters();
    await saveProjectAction(setup, write, { ...action('new'), source: 'personal' }, null, 'personal');
    expect(writes).toEqual([{ file: 'personalActions', value: [action('build'), action('new')] }]);
  });
});

describe('team action visibility and deletion', () => {
  test('hiding and showing a team action only touches the personal hidden list', async () => {
    const setup = setupWith({ shared: [action('dev'), action('lint')], hidden: ['lint'] });
    const { writes, write } = recordingWriters();
    await setSharedActionHidden(setup, write, 'dev', true);
    await setSharedActionHidden(setup, write, 'lint', false);
    expect(writes).toEqual([
      { file: 'hiddenSharedActionIds', value: ['lint', 'dev'] },
      { file: 'hiddenSharedActionIds', value: [] },
    ]);
  });

  test('deleting a hidden team action removes it from the repository and forgets the hide', async () => {
    const setup = setupWith({ shared: [action('dev'), action('lint')], hidden: ['dev'] });
    const { writes, write } = recordingWriters();
    const [entry] = listProjectActions(setup);
    expect(await deleteProjectAction(setup, write, entry)).toBe(true);
    expect(writes).toEqual([
      { file: 'sharedActions', value: [action('lint')] },
      { file: 'hiddenSharedActionIds', value: [] },
    ]);
  });
});

describe('setup commands', () => {
  test('lists team commands first and marks them skipped in "only my commands" mode', () => {
    const setup = setupWith({ sharedCommands: ['bun install'], personalCommands: ['cp .env'], replace: true });
    expect(listSetupCommands(setup).map((entry) => [entry.command, entry.source, entry.skipped])).toEqual([
      ['bun install', 'shared', true],
      ['cp .env', 'personal', false],
    ]);
  });

  test('editing writes the file the command lives in, and empty text removes it', async () => {
    const setup = setupWith({ sharedCommands: ['bun install', 'bun run build'] });
    const { writes, write } = recordingWriters();
    const [first, second] = listSetupCommands(setup);
    await editSetupCommand(setup, write, first, ' bun install --frozen-lockfile ');
    await editSetupCommand(setup, write, second, '   ');
    expect(writes).toEqual([
      { file: 'sharedCommands', value: ['bun install --frozen-lockfile', 'bun run build'] },
      { file: 'sharedCommands', value: ['bun install'] },
    ]);
  });

  test('moving a command appends it to the other file before removing it from its own', async () => {
    const setup = setupWith({ sharedCommands: ['bun install'], personalCommands: ['cp .env'] });
    const { writes, write } = recordingWriters();
    const personal = listSetupCommands(setup)[1];
    expect(await moveSetupCommand(setup, write, personal)).toBe(true);
    expect(writes).toEqual([
      { file: 'sharedCommands', value: ['bun install', 'cp .env'] },
      { file: 'personalCommands', value: [] },
    ]);
  });

  test('a new command goes to the end of personal settings', async () => {
    const setup = setupWith({ personalCommands: ['cp .env'] });
    const { writes, write } = recordingWriters();
    await addSetupCommand(setup, write, ' make dev ');
    expect(writes).toEqual([{ file: 'personalCommands', value: ['cp .env', 'make dev'] }]);
  });
});
