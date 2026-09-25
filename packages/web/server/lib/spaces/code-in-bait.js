// Test support, never imported by product code. The bait repository and the host state that code
// in must leave byte-identical, shared by code-in.test.js and places/code-in.docker.live.test.js.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodeIn } from './code-in.js';
import { createHostGit, hostGitEnvironment } from './host-git.js';
import { runCommand } from './run-command.js';

const WIN = process.platform === 'win32';
export const SECRET = 'bait-secret-do-not-travel-7f3a';
// The content of a tracked file the bait deletes: it lives in git objects only, never in a working tree.
export const OBJECTS_ONLY_TEXT = 'deleted-file-only-in-objects-5c1e';

const roots = [];
/** Removes every folder the helpers here made. Call it in `afterAll`. */
export const removeTestHosts = () => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const forConfig = (file) => file.replaceAll('\\', '/');

// For the git a test runs to set a repository up. A porcelain commit or merge starts
// `git maintenance run --auto --detach`, which can repack the repository in the background while
// the test compares its files before and after the code under test. Only the setup opts out: the
// code under test keeps the host's own maintenance settings.
export const SETUP_GIT = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

/**
 * A host of our own: a temporary directory, a global git config inside it and the environment
 * that points git at it. `config` adds lines to the global config, `identity: false` leaves the
 * user without a name, and `ownHome: false` keeps the real HOME.
 */
export function createTestHost({ config = '', identity = true, ownHome = true } = {}) {
  // The native realpath: on Windows it also expands an 8.3 TEMP such as C:\Users\BOHDAN~1, as git does.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-code-in-test-')));
  roots.push(root);
  const globalIgnore = path.join(root, 'global-ignore');
  fs.writeFileSync(globalIgnore, 'secret-by-global-ignore.txt\n');
  const globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, [
    identity ? '[user]\n\tname = Bait Author\n\temail = bait@example.invalid' : '',
    `[core]\n\texcludesFile = ${forConfig(globalIgnore)}`,
    '[init]\n\tdefaultBranch = main',
    '[advice]\n\taddEmbeddedRepo = false\n\tdetachedHead = false',
    config,
  ].join('\n'));
  // A HOME of its own keeps the developer's files out of the unit tests. The live tests keep the real
  // one, because the docker CLI that git starts finds its context under it.
  const environment = { ...hostGitEnvironment(process.env), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  if (ownHome) environment.HOME = root;
  const git = createHostGit({ runCommand, environment });
  // The setup commits need somebody's name. Only the setup gets one when the user has none.
  const setupIdentity = identity ? {} : { GIT_AUTHOR_NAME: 'Setup', GIT_AUTHOR_EMAIL: 'setup@example.invalid', GIT_COMMITTER_NAME: 'Setup', GIT_COMMITTER_EMAIL: 'setup@example.invalid' };
  const sh = (directory, args, { input } = {}) => {
    const result = spawnSync('git', [...SETUP_GIT, '-C', directory, ...args], { env: { ...environment, ...setupIdentity }, input, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
    return result.stdout;
  };
  // Config that would break the setup itself goes in afterwards.
  const addConfig = (text) => fs.appendFileSync(globalConfig, `\n${text}\n`);
  return { root, environment, git, sh, addConfig, codeIn: (place = null, options = {}) => createCodeIn({ git, place, temporaryDirectory: root, ...options }) };
}

/** The bait repository: every kind of change and every kind of file that must or must not travel. */
function buildBait(host, repo, objectFormat) {
  fs.mkdirSync(repo);
  const g = (args) => host.sh(repo, args);
  const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);
  g(['init', '--quiet', `--object-format=${objectFormat}`]);
  write('.gitignore', '.env\nnode_modules/\n');
  write('README.md', 'hello\n');
  write('run.sh', '#!/bin/sh\necho hi\n');
  write('tracked-to-edit.txt', 'one\n');
  write('tracked-to-delete.txt', `${OBJECTS_ONLY_TEXT}\n`);
  g(['add', '--all']);
  g(['update-index', '--chmod=+x', 'run.sh']);
  if (!WIN) fs.chmodSync(path.join(repo, 'run.sh'), 0o755);
  g(['commit', '--quiet', '-m', 'first']);
  for (let index = 0; index < 3; index += 1) {
    write('history.txt', `line ${index}\n`);
    g(['add', 'history.txt']);
    g(['commit', '--quiet', '-m', `history ${index}`]);
  }
  write('.env', `OPENAI_API_KEY=${SECRET}\n`);
  fs.mkdirSync(path.join(repo, 'node_modules'));
  write('node_modules/x.js', 'x\n');
  write('secret-by-global-ignore.txt', 'global ignore bait\n');
  write('staged-new.txt', 'staged\n');
  g(['add', 'staged-new.txt']);
  write('tracked-to-edit.txt', 'one\ntwo staged\n');
  g(['add', 'tracked-to-edit.txt']);
  write('tracked-to-edit.txt', 'one\ntwo staged\nthree unstaged\n');
  fs.rmSync(path.join(repo, 'tracked-to-delete.txt'));
  write('untracked plain.txt', 'untracked travels\n');
  write('юнікод.txt', 'unicode\n');
  if (!WIN) fs.symlinkSync('README.md', path.join(repo, 'link-to-readme'));
}

// Built once per object format and copied into each test's host, because building it is most of
// what a test here costs. A copy holds no path of the host it was built on.
const baitTemplates = new Map();

export function makeBait(host, { name = 'bait repo ї', objectFormat = 'sha1' } = {}) {
  if (!baitTemplates.has(objectFormat)) {
    const builder = createTestHost();
    const template = path.join(builder.root, 'template');
    buildBait(builder, template, objectFormat);
    baitTemplates.set(objectFormat, template);
  }
  const repo = path.join(host.root, name);
  fs.cpSync(baitTemplates.get(objectFormat), repo, { recursive: true, verbatimSymlinks: true });
  return { repo, g: (args, options) => host.sh(repo, args, options) };
}

/** Files of a tree as `{ path: { mode, id } }`. */
export const readTree = (g, treeish) => Object.fromEntries(g(['ls-tree', '-r', '-z', '--full-tree', treeish]).split('\0').filter(Boolean).map((entry) => {
  const [info, file] = entry.split('\t');
  const [mode, , id] = info.split(' ');
  return [file, { mode, id }];
}));
export const blob = (g, treeish, file) => g(['cat-file', 'blob', `${treeish}:${file}`]);

/**
 * Everything in a repository folder, `.git` included: `{ relative path: description }`, where a
 * description holds the kind, the mode bits except on Windows, and a hash of a file's bytes or a
 * link's target. A new empty folder, a changed mode and a changed byte all show. A socket, a FIFO
 * or a device is described by its type and never read: an fsmonitor daemon keeps a socket in `.git`.
 */
export const hostState = (directory) => {
  const entries = {};
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const full = path.join(directory, name);
      const stats = fs.lstatSync(full);
      const mode = WIN ? '' : (stats.mode & 0o7777).toString(8);
      if (stats.isSymbolicLink()) {
        entries[name] = `link ${fs.readlinkSync(full)}`;
      } else if (stats.isDirectory()) {
        entries[name] = `dir ${mode}`;
        walk(name);
      } else if (!stats.isFile()) {
        entries[name] = `${stats.isSocket() ? 'socket' : stats.isFIFO() ? 'fifo' : 'device'} ${mode}`;
      } else {
        entries[name] = `file ${mode} ${sha256(fs.readFileSync(full))}`;
      }
    }
  };
  walk('');
  return entries;
};

// What code in writes by design, and nothing else:
// 1. new loose objects from the snapshot's `add` and `commit-tree` in the repository's own `.git`,
//    with their fan-out folders, as additions only: a loose object that changed or went, or one in
//    a nested repository's `.git`, is a difference like any other;
// 2. the start ref of the spaces named, `.git/refs/openchamber/spaces/<id>/start`, with the three
//    folders git makes for it, added or removed. A start ref that moved to another commit is a difference.
const LOOSE_OBJECT = /^\.git\/objects\/[0-9a-f]{2}(?:\/(?:[0-9a-f]{38}|[0-9a-f]{62}))?$/;
const spaceRefPaths = (spaceId) => [
  '.git/refs/openchamber',
  '.git/refs/openchamber/spaces',
  `.git/refs/openchamber/spaces/${spaceId}`,
  `.git/refs/openchamber/spaces/${spaceId}/start`,
];

/** The paths that differ between two `hostState`s, apart from what code in writes by design for `spaceIds`. */
export const unexpectedChanges = (before, after, { spaceIds = [] } = {}) => {
  const ownRefs = new Set(spaceIds.flatMap(spaceRefPaths));
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => {
    if (before[name] === after[name]) return false;
    const addedOrRemoved = before[name] === undefined || after[name] === undefined;
    if (ownRefs.has(name) && addedOrRemoved) return false;
    return !(before[name] === undefined && LOOSE_OBJECT.test(name));
  }).sort();
};

export const shortStatus = (g) => g(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']);
