import { describe, expect, test } from 'bun:test';

import { browseTargetForRow, canConfirmPathOnEnter, displayPathToAbsolutePath, ensureBrowseDirectoryPath } from './directoryExplorerPaths';

const TYPED_A_PATH = {
  rowChosen: false,
  targetPath: 'C:/Users/Sam/AppData/Local/Temp/openchamber-functional-project',
  wouldCreate: false,
  isAlreadyAdded: false,
  isBusy: false,
};

const WINDOWS_HOME = 'C:\\Users\\Sam';
const POSIX_HOME = '/home/yulia';

describe('directory explorer path entry', () => {
  test('expands the tilde the field opens with', () => {
    expect(displayPathToAbsolutePath('~', WINDOWS_HOME)).toBe(WINDOWS_HOME);
    expect(displayPathToAbsolutePath('~/projects/openchamber', POSIX_HOME)).toBe('/home/yulia/projects/openchamber');
  });

  test('does not hang a pasted absolute path off the home directory', () => {
    // The caret sits after the `~/` the field opens with, so a paste lands behind it.
    // Joining the two produces a path nobody meant, which the dialog then offers to
    // create — this is how an empty directory ended up in a home folder.
    const pasted = 'C:\\Users\\Sam\\AppData\\Local\\Temp\\openchamber-functional-project';
    expect(displayPathToAbsolutePath('~/' + pasted, WINDOWS_HOME)).toBe(pasted);
    expect(displayPathToAbsolutePath('~//home/yulia/projects/demo', POSIX_HOME)).toBe('/home/yulia/projects/demo');
    expect(displayPathToAbsolutePath('~/\\\\fileserver\\projects', WINDOWS_HOME)).toBe('\\\\fileserver\\projects');
  });

  test('still treats an ordinary relative remainder as relative to home', () => {
    // A bare drive letter is not a path, and a name that merely contains a colon is a
    // directory name — neither may be mistaken for something already rooted.
    expect(displayPathToAbsolutePath('~/projects', WINDOWS_HOME)).toBe('C:\\Users\\Sam/projects');
    expect(displayPathToAbsolutePath('~/notes: draft', POSIX_HOME)).toBe('/home/yulia/notes: draft');
  });

  test('leaves a path typed without the tilde alone', () => {
    expect(displayPathToAbsolutePath('D:\\work\\repo', WINDOWS_HOME)).toBe('D:\\work\\repo');
    expect(displayPathToAbsolutePath('  /srv/repo  ', POSIX_HOME)).toBe('/srv/repo');
  });
});

describe('opening a row in the listing', () => {
  test('goes where the row says, not where the field currently points', () => {
    // The listing arrives asynchronously, so pasting a path and pressing Enter straight
    // away acts on rows that still describe the previous directory. Building the target
    // from the row's bare name and the field would then append a sibling of the old
    // directory to the new path: this is exactly how
    // `…/openchamber-functional-project/~nsu.tmp/` was produced, where `~nsu.tmp` is a
    // directory in Temp and not in the project at all.
    const staleRow = { name: '~nsu.tmp', path: 'C:/Users/Sam/AppData/Local/Temp/~nsu.tmp' };
    const justPasted = 'C:/Users/Sam/AppData/Local/Temp/openchamber-functional-project/';
    expect(browseTargetForRow(staleRow)).toBe('C:/Users/Sam/AppData/Local/Temp/~nsu.tmp/');
    expect(browseTargetForRow(staleRow)).not.toContain(justPasted);
  });

  test('keeps a single trailing separator so the target reads as a directory', () => {
    expect(browseTargetForRow({ name: 'src', path: '/home/yulia/repo/src' })).toBe('/home/yulia/repo/src/');
    expect(browseTargetForRow({ name: 'src', path: '/home/yulia/repo/src/' })).toBe('/home/yulia/repo/src/');
    expect(ensureBrowseDirectoryPath('/home/yulia')).toBe('/home/yulia/');
  });

  test('goes nowhere rather than guessing when the row has no path', () => {
    expect(browseTargetForRow({ name: '..', path: null })).toBeNull();
  });
});

describe('what Enter means in the path field', () => {
  test('adds the path that was typed or pasted', () => {
    // The whole point: the obvious key does the obvious thing, with no second key to know.
    expect(canConfirmPathOnEnter(TYPED_A_PATH)).toBe(true);
  });

  test('navigates instead once a row has actually been reached for', () => {
    // Arrow keys and the pointer set this; the default highlight does not, and the
    // default is the parent link — which is why Enter used to answer a complete path by
    // going up a level.
    expect(canConfirmPathOnEnter({ ...TYPED_A_PATH, rowChosen: true })).toBe(false);
  });

  test('never creates a directory', () => {
    // A path that is not there is how someone filters towards a name; Enter must leave
    // creating to the button that says "create".
    expect(canConfirmPathOnEnter({ ...TYPED_A_PATH, wouldCreate: true })).toBe(false);
  });

  test('does nothing without a path, on a duplicate, or mid-flight', () => {
    expect(canConfirmPathOnEnter({ ...TYPED_A_PATH, targetPath: '' })).toBe(false);
    expect(canConfirmPathOnEnter({ ...TYPED_A_PATH, isAlreadyAdded: true })).toBe(false);
    expect(canConfirmPathOnEnter({ ...TYPED_A_PATH, isBusy: true })).toBe(false);
  });
});
