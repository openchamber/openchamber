import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { promisify } from 'node:util';

const execCalls = [];
const execMock = mock(() => {
  throw new Error('exec should be called through promisify');
});

execMock[promisify.custom] = (command, options) => {
  execCalls.push({ command, options });
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ stdout: '/repo/.git\n/repo/.git\n', stderr: '' });
    }, 10);
  });
};

mock.module('child_process', () => ({
  exec: execMock,
}));

const saveDialogs = [];
const savedFiles = [];
let saveDialogTarget = { fsPath: '/workspace/session.md' };

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {
      writeFile: async (uri, bytes) => {
        savedFiles.push({ uri, bytes });
      },
    },
  },
  Uri: {
    file: (fsPath) => ({ fsPath }),
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  FileType: {
    Directory: 2,
  },
  window: {
    showSaveDialog: async (options) => {
      saveDialogs.push(options);
      return saveDialogTarget;
    },
  },
}));

const { clearGitReadCacheForTests, handleFsBridgeMessage } = await import('./bridge-fs-runtime');

const deps = {
  resolveUserPath: (value) => value,
  listDirectoryEntries: mock(),
  normalizeFsPath: (value) => value,
  execGit: mock(),
  searchDirectory: mock(),
  resolveFileReadPath: mock(),
  parseDroppedFileReference: mock(),
  readUriAsAttachment: mock(),
};

describe('bridge fs exec git read cache', () => {
  beforeEach(() => {
    execCalls.length = 0;
    clearGitReadCacheForTests();
  });

  it('dedupes in-flight cacheable git reads and reuses fresh results', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const cwd = '/repo';

    const [first, second] = await Promise.all([
      handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
      handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
    ]);

    expect(first?.success).toBe(true);
    expect(second?.success).toBe(true);
    expect(execCalls).toHaveLength(1);

    const spacedCommand = 'git   rev-parse   --absolute-git-dir   --git-common-dir';
    const cached = await handleFsBridgeMessage({ id: '3', type: 'api:fs:exec', payload: { commands: [spacedCommand], cwd } }, deps);

    expect(execCalls).toHaveLength(1);
    expect(cached?.data?.results?.[0]).toMatchObject({
      command: spacedCommand,
      success: true,
      stdout: '/repo/.git\n/repo/.git',
    });
  });

  it('does not cache arbitrary exec commands', async () => {
    const command = 'git status --porcelain';
    const cwd = '/repo';

    await handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);
    await handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);

    expect(execCalls).toHaveLength(2);
  });
});

describe('bridge fs save markdown format', () => {
  const save = (payload) => handleFsBridgeMessage(
    { id: 'save', type: 'api:files/save-markdown', payload },
    deps,
  );

  beforeEach(() => {
    saveDialogs.length = 0;
    savedFiles.length = 0;
    saveDialogTarget = { fsPath: '/workspace/session.md' };
  });

  it('saves the content with the filter of the format it was given', async () => {
    const response = await save({ fileName: 'session.html', content: '<p>hello</p>', format: 'html' });

    expect(response?.success).toBe(true);
    expect(saveDialogs[0]?.filters).toEqual({ HTML: ['html'] });
    expect(savedFiles).toHaveLength(1);
    expect(savedFiles[0].bytes.toString('utf8')).toBe('<p>hello</p>');
  });

  it('names a format it does not know instead of calling the payload invalid', async () => {
    const response = await save({ fileName: 'session.md', content: '# hello', format: 'pdf' });

    expect(response?.success).toBe(false);
    expect(response?.error).toBe('Unsupported save format: pdf');
    expect(saveDialogs).toHaveLength(0);
    expect(savedFiles).toHaveLength(0);
  });

  it('names a format that is not a name at all', async () => {
    const response = await save({ fileName: 'session.md', content: '# hello', format: 42 });

    expect(response?.success).toBe(false);
    expect(response?.error).toBe('Unsupported save format: 42');
    expect(savedFiles).toHaveLength(0);
  });

  it('falls back to the Markdown filter when the request names no format', async () => {
    const response = await save({ fileName: 'session.md', content: '# hello' });

    expect(response?.success).toBe(true);
    expect(saveDialogs[0]?.filters).toEqual({ Markdown: ['md'] });
    expect(savedFiles).toHaveLength(1);
    expect(savedFiles[0].bytes.toString('utf8')).toBe('# hello');
  });

  it('reads a blank format name as no format named', async () => {
    const response = await save({ fileName: 'session.md', content: '# hello', format: '  ' });

    expect(response?.success).toBe(true);
    expect(saveDialogs[0]?.filters).toEqual({ Markdown: ['md'] });
    expect(savedFiles).toHaveLength(1);
  });

  it('refuses an empty document and writes nothing', async () => {
    const response = await save({ fileName: 'session.md', content: '', format: 'html' });

    expect(response?.success).toBe(false);
    expect(response?.error).toBe('Invalid markdown payload');
    expect(saveDialogs).toHaveLength(0);
    expect(savedFiles).toHaveLength(0);
  });
});
