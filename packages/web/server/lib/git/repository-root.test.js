import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsupportedRepositoryRootReason, vcsInitRefusal } from './repository-root.js';

describe('unsupportedRepositoryRootReason', () => {
  it('rejects a repository rooted at a filesystem root or the home directory', () => {
    const home = path.join(os.tmpdir(), 'unsupported-root-home');
    expect(unsupportedRepositoryRootReason('/', home)).toBe('filesystem-root');
    expect(unsupportedRepositoryRootReason(path.parse(process.cwd()).root, home)).toBe('filesystem-root');
    expect(unsupportedRepositoryRootReason(home, home)).toBe('home');
    expect(unsupportedRepositoryRootReason(`${home}${path.sep}`, home)).toBe('home');
  });

  it('accepts an ordinary project root, including one directly under home', () => {
    const home = path.join(os.tmpdir(), 'unsupported-root-home');
    expect(unsupportedRepositoryRootReason(path.join(home, 'project'), home)).toBeNull();
    expect(unsupportedRepositoryRootReason(path.join(os.tmpdir(), 'repo'), home)).toBeNull();
    expect(unsupportedRepositoryRootReason('', home)).toBeNull();
  });
});

describe('vcsInitRefusal', () => {
  let home;
  let project;
  let homeLink;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-init-home-'));
    project = path.join(home, 'my project');
    fs.mkdirSync(project);
    homeLink = path.join(os.tmpdir(), `vcs-init-home-link-${process.pid}`);
    fs.symlinkSync(home, homeLink, 'junction');
  });

  afterAll(() => {
    // unlink, not rm: Node 24.13 refuses to rm a link that points at a folder.
    fs.unlinkSync(homeLink);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const header = (directory) => ({ 'x-opencode-directory': encodeURIComponent(directory) });

  it('lets an ordinary project directory through', () => {
    expect(vcsInitRefusal('POST', '/api/vcs/init', header(project), home)).toBeNull();
    expect(vcsInitRefusal('POST', `/api/vcs/init?location%5Bdirectory%5D=${encodeURIComponent(project)}`, {}, home)).toBeNull();
  });

  it('refuses the home directory, also through a symlink or a trailing slash', () => {
    expect(vcsInitRefusal('POST', '/api/vcs/init', header(home), home)).toMatch(/home directory/);
    expect(vcsInitRefusal('POST', '/api/vcs/init', header(`${home}/`), home)).toMatch(/home directory/);
    expect(vcsInitRefusal('POST', '/api/vcs/init', header(homeLink), home)).toMatch(/home directory/);
  });

  it('refuses a filesystem root', () => {
    expect(vcsInitRefusal('POST', '/api/vcs/init', header(path.parse(project).root), home)).toMatch(/root of a disk/);
  });

  it('refuses a request without a directory, which OpenCode would run in its own working directory', () => {
    expect(vcsInitRefusal('POST', '/api/vcs/init', {}, home)).toMatch(/project directory/);
  });

  it('reads the location query before the header, as OpenCode does', () => {
    const url = `/api/vcs/init?location%5Bdirectory%5D=${encodeURIComponent(home)}`;
    expect(vcsInitRefusal('POST', url, header(project), home)).toMatch(/home directory/);
  });

  it('unwraps a header the browser re-encoded once more', () => {
    const doubled = { 'x-opencode-directory': encodeURIComponent(encodeURIComponent(home)), 'x-opencode-directory-encoding': 'uri' };
    expect(vcsInitRefusal('POST', '/api/vcs/init', doubled, home)).toMatch(/home directory/);
  });

  it('matches the route however the path is spelled', () => {
    expect(vcsInitRefusal('POST', '//api/VCS/init/', header(home), home)).toMatch(/home directory/);
    expect(vcsInitRefusal('POST', '/api/vcs/%69nit?x=1#frag', header(home), home)).toMatch(/home directory/);
  });

  it('ignores other routes and methods', () => {
    expect(vcsInitRefusal('GET', '/api/vcs/init', header(home), home)).toBeNull();
    expect(vcsInitRefusal('POST', '/api/vcs', header(home), home)).toBeNull();
    expect(vcsInitRefusal('POST', '/api/session', {}, home)).toBeNull();
  });
});
