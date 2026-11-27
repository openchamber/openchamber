import { describe, expect, it } from 'vitest';

import { createCanonicalPaths } from './canonical-paths.js';

const posixPath = { join: (...parts) => parts.join('/').replace(/\/+/g, '/') };
const winPath = { join: (...parts) => parts.join('\\').replace(/\\+/g, '\\') };
const listingOf = (tree, reads = []) => async (directory) => {
  reads.push(directory);
  if (!Object.hasOwn(tree, directory)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return tree[directory];
};
const tree = {
  '/': ['Users'],
  '/Users': ['me'],
  '/Users/me': ['Desktop'],
  '/Users/me/Desktop': ['VcFiles'],
  '/Users/me/Desktop/VcFiles': ['app'],
};
const createPaths = (overrides = {}) => createCanonicalPaths({
  path: posixPath,
  platform: 'darwin',
  realpath: async (value) => value,
  readdir: listingOf(tree),
  checkDirectory: async () => 'available',
  ...overrides,
});
const canonical = async (paths, value) => {
  await paths.refresh([value]);
  return paths.of(value);
};

describe('canonical settings paths', () => {
  it('resolves symbolic links', async () => {
    const paths = createPaths({ platform: 'linux', realpath: async () => '/workplace/user' });
    expect(await canonical(paths, '/home/user/workplace')).toBe('/workplace/user');
  });

  it('recovers the on-disk casing (#1913)', async () => {
    expect(await canonical(createPaths(), '/users/me/desktop/vcfiles/app')).toBe('/Users/me/Desktop/VcFiles/app');
    expect(await canonical(createPaths(), '/Users/me/Desktop/VcFiles/app')).toBe('/Users/me/Desktop/VcFiles/app');
    expect(await canonical(createPaths(), '/Users/me/Desktop/nonexistent/app')).toBe('/Users/me/Desktop/nonexistent/app');
    expect(await canonical(createPaths({ platform: 'linux' }), '/users/me/desktop/vcfiles/app')).toBe('/users/me/desktop/vcfiles/app');
  });

  it('keeps a path realpath cannot resolve instead of recovering a sibling\'s case', async () => {
    for (const code of ['ENOENT', 'EACCES']) {
      const paths = createPaths({ realpath: async () => { throw Object.assign(new Error(code), { code }); } });
      expect(await canonical(paths, '/users/me/desktop/vcfiles/app')).toBe('/users/me/desktop/vcfiles/app');
    }
  });

  it('treats a backslash as part of a name on macOS', async () => {
    const paths = createPaths({ readdir: listingOf({ '/': ['Users'], '/Users': ['me'], '/Users/me': ['A\\B', 'A'], '/Users/me/A': ['B'], '/Users/me/A\\B': [] }) });
    expect(await canonical(paths, '/Users/me/A\\B')).toBe('/Users/me/A\\B');
  });

  it('recovers on-disk casing on Windows', async () => {
    const paths = createPaths({
      path: winPath,
      platform: 'win32',
      readdir: listingOf({ 'C:\\': ['Users'], 'C:\\Users': ['me'], 'C:\\Users\\me': ['Desktop'], 'C:\\Users\\me\\Desktop': ['app'] }),
    });
    expect(await canonical(paths, 'C:\\users\\me\\desktop\\app')).toBe('C:\\Users\\me\\Desktop\\app');
  });

  it('reads each shared ancestor once per refresh (#6084)', async () => {
    const reads = [];
    const paths = createPaths({ readdir: listingOf({ '/': ['Users'], '/Users': ['me'], '/Users/me': ['Code'], '/Users/me/Code': ['a', 'b', 'Locked'] }, reads) });
    const values = ['/users/me/code/a', '/Users/me/Code/b', '/users/me/code/locked/c', '/Users/me/Code/Locked/d'];
    await paths.refresh(values);
    expect(values.map(paths.of)).toEqual(['/Users/me/Code/a', '/Users/me/Code/b', '/users/me/code/locked/c', '/Users/me/Code/Locked/d']);
    expect(reads.sort()).toEqual(['/', '/Users', '/Users/me', '/Users/me/Code', '/Users/me/Code/Locked']);
  });

  it('keeps the last canonical path while a folder is unreachable and never touches its disk', async () => {
    let reachability = 'available';
    let touched = 0;
    const paths = createPaths({ platform: 'linux', realpath: async () => { touched += 1; return '/real/nas'; }, checkDirectory: async () => reachability });
    expect(await canonical(paths, '/nas')).toBe('/real/nas');
    reachability = 'unreachable';
    expect(await canonical(paths, '/nas')).toBe('/real/nas');
    expect(touched).toBe(1);
  });

  it('answers within its wait when a folder never does, and takes the answer once it comes', async () => {
    let answer;
    const paths = createPaths({ platform: 'linux', realpath: () => new Promise((resolve) => { answer = resolve; }), refreshWaitMs: 20 });
    expect(await canonical(paths, '/slow')).toBe('/slow');
    answer('/real/slow');
    await expect.poll(() => paths.of('/slow')).toBe('/real/slow');
  });

  it('asks again for a path whose earlier lookup never ends', async () => {
    let hung = true;
    const paths = createPaths({ platform: 'linux', realpath: (value) => (hung ? new Promise(() => {}) : Promise.resolve(`/real${value}`)), refreshWaitMs: 20 });
    expect(await canonical(paths, '/nas')).toBe('/nas');
    hung = false;
    await expect.poll(() => canonical(paths, '/nas'), { timeout: 6000 }).toBe('/real/nas');
  }, 10_000);
});
