// Test support, never imported by product code. The bait repository, the host state that code in
// and code out must leave byte-identical, and a stand-in for a space in a local folder, shared by
// code-in.test.js, code-out.test.js and the live files under places/.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'vitest';

import { createCodeIn } from './code-in.js';
import { createCodeOut } from './code-out.js';
import { SpaceError } from './errors.js';
import { createHostGit, hostGitEnvironment } from './host-git.js';
import { IMAGE_ONLY_PATH, IMAGE_SH, IMAGE_TIMEOUT } from './layout.js';
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
  return {
    root, environment, git, sh, addConfig,
    codeIn: (place = null, options = {}) => createCodeIn({ git, place, temporaryDirectory: root, ...options }),
    codeOut: (place = null, options = {}) => createCodeOut({ git, place, temporaryDirectory: root, ...options }),
  };
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
// With `codeOut`, also what code out writes by design:
// 3. new packs, which a fetch writes when it brings many objects, as additions only;
// 4. the result ref of the spaces named, `.git/refs/openchamber/spaces/<id>/result`, the ref of what
//    the last apply as uncommitted changes wrote, `.../applied`, the intent written while an apply
//    runs, `.../applying`, what the patch of each was built from, `.../applied-from` and
//    `.../applying-from`, the user's HEAD at each, `.../applied-head` and `.../applying-head`, and the
//    one that says this space is applied as a branch from now on,
//    `.../changes-closed`, added, removed or moved, because a later call moves each of them.
const LOOSE_OBJECT = /^\.git\/objects\/[0-9a-f]{2}(?:\/(?:[0-9a-f]{38}|[0-9a-f]{62}))?$/;
const NEW_PACK = /^\.git\/objects\/pack\/pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.(?:pack|idx|rev)$/;
const spaceRefPaths = (spaceId) => [
  '.git/refs/openchamber',
  '.git/refs/openchamber/spaces',
  `.git/refs/openchamber/spaces/${spaceId}`,
  `.git/refs/openchamber/spaces/${spaceId}/start`,
];

/**
 * The paths that differ between two `hostState`s, apart from what code in writes by design for
 * `spaceIds`, and with `codeOut: true` also what code out writes by design for them.
 */
export const unexpectedChanges = (before, after, { spaceIds = [], codeOut = false } = {}) => {
  const ownRefs = new Set(spaceIds.flatMap(spaceRefPaths));
  const resultRefs = new Set(codeOut
    ? spaceIds.flatMap((spaceId) => ['result', 'applied', 'applied-from', 'applied-head', 'applying', 'applying-from', 'applying-head', 'changes-closed'].map((name) => `.git/refs/openchamber/spaces/${spaceId}/${name}`))
    : []);
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => {
    if (before[name] === after[name]) return false;
    if (resultRefs.has(name)) return false;
    const addedOrRemoved = before[name] === undefined || after[name] === undefined;
    if (ownRefs.has(name) && addedOrRemoved) return false;
    const added = before[name] === undefined;
    if (added && codeOut && NEW_PACK.test(name)) return false;
    return !(added && LOOSE_OBJECT.test(name));
  }).sort();
};

export const shortStatus = (g) => g(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']);

// The other end of a push or fetch, standing in for `docker exec ... git receive-pack` or
// `git upload-pack` in a real space. It checks that the host wrote out the fixed command, and maps
// /spaces/ into a local folder. `slow` sends what upload-pack sends at about 3 MB/s, and every run
// records how its git ended in `<service>.exit`, which a killed run never writes.
const RECEIVER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [root, behaviour, services, ...command] = process.argv.slice(2);
const [timeoutPath, dashS, signal, seconds, gitPath, service, target] = command;
if (command.length !== 7 || timeoutPath !== '/usr/bin/timeout' || dashS !== '-s' || signal !== 'KILL' || !/^[0-9]+$/.test(seconds)
  || gitPath !== '/usr/bin/git' || !services.split(',').includes(service) || !target.startsWith('/spaces/')) {
  process.stderr.write('unexpected command ' + JSON.stringify(command) + '\\n');
  process.exit(2);
}
fs.writeFileSync(path.join(root, 'last-command.json'), JSON.stringify(command));
fs.appendFileSync(path.join(root, 'commands.log'), target + '\\n');
if (behaviour === 'refuse') { process.stderr.write('refused by the space\\n'); process.exit(1); }
if (behaviour === 'flood') {
  const chunk = 'x'.repeat(65536);
  const pump = () => { while (process.stderr.write(chunk)) {} process.stderr.once('drain', pump); };
  pump();
} else if (behaviour === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'hang.pid'), String(grandchild.pid));
  setInterval(() => {}, 1000);
} else {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const slow = behaviour === 'slow';
  const child = spawn('git', [service, path.join(root, target)], {
    stdio: ['inherit', slow ? 'pipe' : 'inherit', 'inherit'],
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: ${JSON.stringify(os.devNull)} },
  });
  if (slow) {
    child.stdout.on('data', (chunk) => {
      child.stdout.pause();
      process.stdout.write(chunk);
      setTimeout(() => child.stdout.resume(), Math.ceil(chunk.length / 3000));
    });
  }
  // The receiver ends by itself once git has closed and everything is written.
  child.on('close', (code) => {
    fs.writeFileSync(path.join(root, service + '.exit'), String(code));
    process.exitCode = code ?? 1;
  });
}
`;

/**
 * A stand-in place for one space in a local folder. `exec` runs the module's fixed scripts with the
 * host's `sh` and `git`, with /spaces/ mapped into the folder and a `timeout` that only drops its
 * limit, since the host may have none; a script may come under the image's `timeout` itself.
 * `execArgv` points at RECEIVER, kept in a folder whose name has a space and a percent sign, so the
 * ext escaping is exercised through git itself. `setBehaviour` changes what the next transfer meets.
 * POSIX only: the scripts run with `/bin/sh`.
 *
 * Without `codeOut` it stands in for code in alone, and is as strict as code in: only `receive-pack`,
 * and no script wrapped in the image's `timeout`. With it, `upload-pack` and a wrapped script are
 * allowed too, and the wrapper's seconds are checked.
 */
export function createLocalPlace(host, behaviour = 'receive', spaceId = 'a1b2c3d4e5f6', { codeOut = false } = {}) {
  const root = path.join(host.root, 'stand in 50% place');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(root, 'spaces', spaceId), { recursive: true });
  fs.mkdirSync(bin);
  const receiver = path.join(root, 'receiver.cjs');
  fs.writeFileSync(receiver, RECEIVER);
  fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const emptyConfig = path.join(root, 'inside-gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const insideEnvironment = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig };
  const local = (inside) => path.join(root, inside);
  let current = behaviour;
  return {
    root,
    local,
    setBehaviour: (next) => { current = next; },
    inside: (args, { env = {}, input } = {}) => {
      const result = spawnSync('git', args, { env: { ...insideEnvironment, ...env }, input, encoding: 'utf8' });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    lastCommand: () => JSON.parse(fs.readFileSync(path.join(root, 'last-command.json'), 'utf8')),
    /** How many pushes reached the history side repository. */
    historyPushes: () => (fs.existsSync(path.join(root, 'commands.log')) ? fs.readFileSync(path.join(root, 'commands.log'), 'utf8').split('\n').filter((line) => line.endsWith('.openchamber-history.git')).length : 0),
    hangPid: () => Number(fs.readFileSync(path.join(root, 'hang.pid'), 'utf8')),
    /** How the last upload-pack ended, or null when it was killed before it could say. */
    uploadPackExit: () => (fs.existsSync(path.join(root, 'upload-pack.exit')) ? fs.readFileSync(path.join(root, 'upload-pack.exit'), 'utf8') : null),
    place: {
      execArgv: async (id) => {
        if (id !== spaceId) throw new SpaceError('space_not_found', 'no such space');
        return [process.execPath, receiver, path.join(root), current, codeOut ? 'receive-pack,upload-pack' : 'receive-pack'];
      },
      exec: async (id, argv, { timeoutMs }) => {
        const wrapped = argv[0] === IMAGE_TIMEOUT;
        const unlimited = wrapped ? argv.slice(4) : argv;
        if (wrapped) {
          expect(codeOut, 'code in runs no script under the image timeout').toBe(true);
          expect(argv.slice(1, 3)).toEqual(['-s', 'KILL']);
          expect(Number(argv[3]), 'the seconds of the inner limit').toBeGreaterThan(0);
        }
        const [shell, flag, script, zero, ...args] = unlimited;
        expect([shell, flag, zero]).toEqual([IMAGE_SH, '-c', 'sh']);
        expect(script.startsWith(IMAGE_ONLY_PATH)).toBe(true);
        // Quoted: the stand-in's folder name has a space in it, which the image's own PATH never has.
        const localScript = `PATH='${insideEnvironment.PATH}';${script.slice(IMAGE_ONLY_PATH.length)}`;
        return runCommand('/bin/sh', ['-c', localScript, zero, ...args.map((arg) => (arg.startsWith('/spaces/') ? local(arg) : arg))], { env: insideEnvironment, timeoutMs });
      },
    },
  };
}
