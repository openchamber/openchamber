// Code out: the result of a space travels back to the user's repository as git objects over the
// place's exec channel, and is applied there as a branch or as uncommitted changes. The host drives
// every step. The command sequences follow docs/isolated-spaces/stage-0/e4-git-over-exec.md.
//
// Everything that comes out of a space is untrusted data. The space can send hostile objects, send
// without end, hang, lie about its history, or print a lot. Its objects land in a throwaway
// quarantine repository first and are checked there; the user's repository gets them only after
// that, and the patch that is applied is built on the host from two trees it holds.

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  EXT_UNCARRIABLE, INNER_MARGIN_SECONDS, SNAPSHOT_IDENTITY, buildExtUrl, createTransferSession, innerSeconds, line,
  objectIdPattern, requireInnerMargin, requireTimeout, spaceRefPrefix, startRef, zeroObjectId,
} from './code-transfer.js';
import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { requireSpaceId } from './labels.js';
import { IMAGE_GIT, IMAGE_ONLY_PATH, IMAGE_SH, IMAGE_TIMEOUT, requireSpaceProjectPath } from './layout.js';

// The host's deadline for the fetch out of the space, the same as for a push of code in.
const FETCH_TIMEOUT_MS = 10 * 60_000;
// The snapshot inside is `add --all` over the agent's working tree, which a large tree makes slow.
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
// Building the patch and applying it read and write up to `maxChangedBytes`.
const APPLY_TIMEOUT_MS = 10 * 60_000;
// Compressed bytes the space may send, measured on the quarantine folder while it grows. Twice the
// changed-bytes cap below: a pack of the new objects is not larger than what they inflate to, plus
// commits and trees. Measured locally, the quarantine overshoots by what arrives in one poll. It
// counts bytes on the wire, so it says little about what they inflate to; that is what the caps
// after the fetch are for.
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
// Bytes one result may be worth, on two counts: everything new its history brings, which is what the
// user's repository keeps, and what a patch of it would read and write, which is what an apply costs.
// Both sides of every changed path count, deletions included. Measured on macOS with git 2.50.1, the
// worst case this cap allows: a 64 MiB text file rewritten line by line, 128 MiB charged, made a
// 137 MB patch on disk, `diff-tree -p --binary` peak at 0.41 GB and `apply` at 0.54 GB. Twice this
// cap costs twice that: 256 MiB charged took 1.6 GB and 2.2 GB, and at 1 GiB `git apply` refuses the
// patch outright, a limit of git's own.
const MAX_CHANGED_BYTES = 128 * 1024 * 1024;
// What one object that is not a file may hold. A commit message or a tree entry list of real work is
// far below this; four megabytes is a tree of about a hundred thousand entries. Such an object is
// cheap on the wire and expensive on the host, which is why it has a cap of its own: measured by a
// reviewer, a 250 MiB commit message travelled as 256 KB and made `diff-tree` peak at 505 MB.
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
// Changed paths in the result, and new objects in its history. A hundred thousand is more than a
// whole large repository's files, and bounds every list the host reads.
const MAX_CHANGED_ENTRIES = 100_000;
// A quiet fetch prints nothing. What it does print comes from the space.
const FETCH_MAX_OUTPUT_BYTES = 1024 * 1024;
const LIST_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SIZE_POLL_MS = 100;

// The ref the snapshot inside writes, and the one the quarantine fetches it into.
const INSIDE_RESULT = 'refs/openchamber/result';
const QUARANTINE_RESULT = 'refs/openchamber/result';
const resultRef = (spaceId) => `${spaceRefPrefix(spaceId)}result`;
// What the last apply as uncommitted changes wrote into the working tree. A second apply starts from
// it, so it brings only what is new since then. A service ref of ours, which is also what keeps the
// commit alive through a garbage collection; DESIGN.md allows these under `refs/openchamber/`.
const appliedRef = (spaceId) => `${spaceRefPrefix(spaceId)}applied`;
// Written once the work of a space and the user's project have gone apart, at the result that was
// refused. From then on this space is applied as a branch, and nothing in this stage reopens it.
const closedRef = (spaceId) => `${spaceRefPrefix(spaceId)}changes-closed`;
// Written just before `git apply` writes into the working tree, and replaced by `applied` once it is
// done. Found on a later call, it means the host went away in between: that call looks at the working
// tree and finishes the record, forgets the attempt, or says that part of it is there.
const applyingRef = (spaceId) => `${spaceRefPrefix(spaceId)}applying`;
// What the user reads in every refusal that closes the route, and in every attempt after it.
const BRANCH_FROM_NOW_ON = 'From now on this space is applied as a branch, which holds its whole work, the rounds you already applied included.';

const UNCOMMITTED_MESSAGE = 'openchamber: uncommitted changes from the space\n\nWhat was uncommitted in the space when its work was brought out. Some of it may be the work you had uncommitted when the space was made.';

// Paths the host reports back from one call. They are for the caller to show, and the count says how
// many there are when the list stops here.
const MAX_REPORTED_PATHS = 100;

// How much of the unmerged listing the script sends back. A longer one is cut there and the count
// says what was read, so a space cannot fail the whole code out by printing without end.
const MAX_REPORT_BYTES = 256 * 1024;

// The fixed script inside, run under the image's `timeout`. Every value is a positional argument:
// $1 the project path, $2 the message, $3 the name, $4 the email. A copy of the index takes the
// working tree, so the agent's own index and working tree stay as they are. When nothing is
// uncommitted, the result is HEAD itself.
//
// Its report goes on a channel of its own, file descriptor 3, which is this script's real stdout;
// everything the script runs writes to /dev/null instead and runs with descriptor 3 closed, so a hook
// of the agent's can neither print into the report through its parent's stdout nor write to the
// report's own descriptor. Only the two commands at the end write the report. The report is the id of the commit the script made, then the
// unmerged entries of the space's index, read before `add --all` stages their conflicted content.
// It is data from the space all the same: the host takes the id only to require that exact object
// from the fetch, and the paths only to show.
const SNAPSHOT_SCRIPT = [
  IMAGE_ONLY_PATH,
  'exec 3>&1 >/dev/null;',
  '{',
  'cd "$1" || exit 1;',
  'report=$(git rev-parse --git-path openchamber-unmerged) || exit 1;',
  `git ls-files --unmerged -z | head -c ${MAX_REPORT_BYTES} > "$report";`,
  'head=$(git rev-parse --verify --quiet "HEAD^{commit}") || { echo "The repository in the space has no commit at HEAD." >&2; exit 1; };',
  'index=$(git rev-parse --git-path index) && copy=$(git rev-parse --git-path openchamber-result-index) || exit 1;',
  'rm -f "$copy";',
  'if [ -e "$index" ]; then cp "$index" "$copy" || exit 1; fi;',
  'GIT_INDEX_FILE="$copy" git -c core.splitIndex=false add --all && tree=$(GIT_INDEX_FILE="$copy" git -c core.splitIndex=false write-tree);',
  'status=$?; rm -f "$copy"; [ "$status" -eq 0 ] || exit 1;',
  'if [ "$tree" = "$(git rev-parse "$head^{tree}")" ]; then result=$head;',
  'else result=$(GIT_AUTHOR_NAME="$3" GIT_AUTHOR_EMAIL="$4" GIT_COMMITTER_NAME="$3" GIT_COMMITTER_EMAIL="$4" git commit-tree --no-gpg-sign "$tree" -p "$head" -m "$2") || exit 1; fi;',
  `git update-ref ${INSIDE_RESULT} "$result" || exit 1;`,
  '} 3>&-;',
  'printf "%s\n" "$result" >&3;',
  'cat "$report" >&3;',
  'rm -f "$report"',
].join(' ');

// Config for every fetch of code out. Objects are checked on the way in. Nothing is pruned, no
// commit graph is written into the user's `.git`, and no remote config is read, because the
// source is a URL and the refspec is explicit.
const FETCH_CONFIG = [
  '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
  '-c', 'fetch.prune=false', '-c', 'fetch.writeCommitGraph=false',
];
// The quarantine keeps what arrives as a pack, written while it arrives, so its folder grows with the
// transfer and the cap sees it. Below the unpack limit, 100 objects by default, git unpacks into
// loose objects and writes each only once it is whole, a single large file at the very end. Measured
// with git 2.50.1, `fetch.fsckObjects` alone already makes git keep a pack; this does not rely on it.
const QUARANTINE_CONFIG = ['-c', 'fetch.unpackLimit=1', '-c', 'transfer.unpackLimit=1'];
// `--refmap=` maps nothing beyond the one refspec. No FETCH_HEAD, no tags, no submodules, no gc.
const FETCH_FLAGS = ['--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-gc', '--refmap='];

// The patch, from git's plumbing, which ignores the user's `diff.noprefix`, `diff.relative`,
// colours and prefixes. The rest is said explicitly anyway.
const PATCH_ARGS = ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
// `apply.whitespace=fix` changed content silently and `apply.whitespace=error` refused, measured with
// git 2.50.1; `apply.ignoreWhitespace=change` lets a patch land on lines that differ. Those are the
// only two `apply.*` settings in git's manual. Never `--unsafe-paths`, `--3way` or `--index`.
const APPLY_ARGS = ['-c', 'apply.whitespace=nowarn', '-c', 'apply.ignoreWhitespace=no', 'apply', '--binary', '--whitespace=nowarn'];

const LIMIT_NAMES = ['maxTransferBytes', 'maxChangedBytes', 'maxChangedEntries'];
const requireLimit = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SpaceError('invalid_limit', `${name} is a whole number greater than zero`);
  }
  return value;
};

// What `bringCodeOut` rejects with as it is. Everything else, a failure of the place, of the runner
// or of a host git step, becomes code_out_failed with that code as `details.cause`.
const OUT_CODES = new Set([
  'invalid_space_id', 'invalid_space_path', 'invalid_timeout', 'invalid_inner_margin', 'invalid_limit',
  'git_version_unreadable', 'git_too_old', 'project_folder_missing', 'not_a_git_work_tree', 'space_start_missing',
  'code_out_failed', 'result_ref_missing', 'result_not_a_commit', 'result_transfer_too_large', 'result_too_large', 'result_too_many_changes',
]);

const pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

/** The bytes of every file under `directory`. Entries that vanish while it counts, a pack being renamed among them, count as nothing. */
async function folderBytes(directory) {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await folderBytes(full);
    } else {
      total += await fs.lstat(full).then((stats) => stats.size, () => 0);
    }
  }
  return total;
}

/**
 * How this repository's file system compares names, as git itself found out when it made the
 * repository: `core.ignorecase` when two names that differ only in case are one file, and
 * `core.precomposeunicode` when the two Unicode spellings of an accent are one name, as on macOS.
 * Both are read from the repository, not guessed from the operating system: a case-sensitive macOS
 * volume and a case-blind disk on Linux each get what they are.
 */
const nameFolder = ({ ignoreCase, precompose }) => (name) => {
  const composed = precompose ? name.normalize('NFC') : name;
  return ignoreCase ? composed.toLowerCase() : composed;
};

/**
 * The first folder on the way to one of `paths` inside the work tree `top` that is not a plain folder
 * of that work tree, or null. `git apply` must not be trusted with this: measured on Windows 11 with
 * Git for Windows 2.54, it wrote through a directory junction, where git on POSIX refuses with "beyond
 * a symbolic link". A folder is refused when `lstat` says it is a link, which Node reports for a
 * symbolic link on every system and for a junction on Windows, because libuv turns both reparse tags
 * into a link; and when its real path is not the same folder inside the real work tree, compared the
 * way this file system compares names (`ignoreCase`, `precompose`), which also catches any other kind
 * of redirection that is not reported as a link. Folders that do not exist yet are fine: apply makes
 * them.
 *
 * Each folder is looked at once with `lstat`. The real path is asked once per path, of its deepest
 * folder that exists, because that one answer covers every folder above it; only when it does not
 * match is each folder on the way asked, to name the first that leads elsewhere. `lstat` and
 * `realpath` are for the tests, which cannot build every kind of redirection on every system.
 */
export async function firstRedirectedFolder(top, paths, { ignoreCase = false, precompose = false, lstat = fs.lstat, realpath = fs.realpath } = {}) {
  const root = await realpath(top);
  const fold = nameFolder({ ignoreCase, precompose });
  const kinds = new Map();
  const reals = new Map();
  const leadsElsewhere = async (relative) => {
    if (!reals.has(relative)) {
      const real = path.relative(root, await realpath(path.join(top, ...relative.split('/')))).split(path.sep).join('/');
      reals.set(relative, fold(real) !== fold(relative));
    }
    return reals.get(relative);
  };
  for (const file of paths) {
    const folders = file.split('/').slice(0, -1);
    let relative = '';
    let deepest = '';
    for (const folder of folders) {
      relative = relative === '' ? folder : `${relative}/${folder}`;
      if (!kinds.has(relative)) {
        let kind = 'folder';
        try {
          const stats = await lstat(path.join(top, ...relative.split('/')));
          if (stats.isSymbolicLink()) kind = 'link';
          else if (!stats.isDirectory()) kind = 'other';
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
          kind = 'absent';
        }
        kinds.set(relative, kind);
      }
      const kind = kinds.get(relative);
      if (kind === 'link') return relative;
      if (kind !== 'folder') break;
      deepest = relative;
    }
    if (deepest !== '' && await leadsElsewhere(deepest)) {
      let above = '';
      for (const folder of deepest.split('/')) {
        above = above === '' ? folder : `${above}/${folder}`;
        if (await leadsElsewhere(above)) return above;
      }
    }
  }
  return null;
}

// What a file name must not be on this computer, per platform, on purpose: a space runs Linux, where
// almost any name is fine, and the user's computer may not hold it. Windows, from Microsoft's "Naming
// Files, Paths, and Namespaces" (learn.microsoft.com, windows/win32/fileio/naming-a-file) and from
// git's own `is_valid_win32_path` in compat/mingw.c, which Git for Windows applies with
// `core.protectNTFS`; a name is refused when either of the two refuses it:
// - the reserved characters < > : " / \ | ? * and the characters 1 to 31 (both sources; `/` never
//   reaches a name, it is git's separator, and NUL cannot be in a git tree at all);
// - a trailing space or period (Microsoft: "Do not end a file or directory name with a space or a
//   period"; git: "cannot end in ` ` or `.`");
// - the device names CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9, in any case, alone or followed
//   by spaces and then an extension or a colon (both sources), COM and LPT with the superscript
//   digits ¹ ² ³ (Microsoft), LPT0, CONIN$ and CONOUT$ (git);
// - a whole path longer than 259 characters, unless the repository has `core.longpaths` (Microsoft:
//   MAX_PATH is 260 including the terminating null; Git for Windows lifts it with that setting).
// macOS and Linux refuse only NUL and `/` in a name, and neither can come out of a git tree. On every
// platform a name longer than 255 bytes and a path longer than 1024 bytes are refused: 255 is the
// longest name ext4, APFS and NTFS hold, and 1024 is macOS's PATH_MAX, the smallest of the three
// systems. Those two are also what keep the check below cheap. Names that differ only in case are one
// file where the repository says so; see `nameNotAllowedHere`.
const WINDOWS_RESERVED_CHARACTER = /[<>:"/\\|?*\x01-\x1f]/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[0-9¹²³]) *(?:[.:]|$)/i;
const WINDOWS_TRAILING = /[ .]$/;
const WINDOWS_MAX_PATH = 259;
const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 1024;

/** Why one name cannot exist on `platform`, or null. */
const nameRule = (name, platform) => {
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return 'name_too_long';
  if (platform !== 'win32') return null;
  if (WINDOWS_RESERVED_CHARACTER.test(name)) return 'reserved_character';
  if (WINDOWS_DEVICE_NAME.test(name)) return 'device_name';
  if (WINDOWS_TRAILING.test(name)) return 'trailing_space_or_period';
  return null;
};

/**
 * The first path among `created` that cannot exist here, as `{ path, rule, other }`, or null.
 * `created` are the paths a patch adds, `all` every path of the tree it leads to, and `deleted` the
 * paths it removes. Every folder and file name on the way of a created path is checked against the
 * rules above, `top` and `longPaths` giving the whole path's length on Windows.
 *
 * Where the repository compares names without case or Unicode form, a created name is also compared
 * with the other names in its folder: `differs_only_in_case` when another spelling of it stays in the
 * tree, which on this disk would be one file, and `case_only_rename` when the other spelling is one
 * the patch removes, which `git apply` cannot turn into the new one here. A pair of spellings that
 * both existed before the patch is the user's own and passes. Only the folders on the way of created
 * paths are ever held in memory, one node per name, so the cost is the length of the listing and not
 * its square.
 */
export function nameNotAllowedHere(created, all, { platform = process.platform, ignoreCase = false, precompose = false, deleted = [], top = '', longPaths = false } = {}) {
  for (const file of created) {
    if (Buffer.byteLength(file) > MAX_PATH_BYTES) return { path: file, rule: 'path_too_long', other: null };
    if (platform === 'win32' && !longPaths && top !== '' && path.win32.join(top, file).length > WINDOWS_MAX_PATH) return { path: file, rule: 'path_too_long', other: null };
    for (const name of file.split('/')) {
      const rule = nameRule(name, platform);
      if (rule) return { path: file, rule, other: null };
    }
  }
  if ((!ignoreCase && !precompose) || created.length === 0) return null;
  const fold = nameFolder({ ignoreCase, precompose });
  const node = () => ({ children: new Map(), spellings: new Map() });
  const root = node();
  for (const file of created) {
    let at = root;
    for (const name of file.split('/')) {
      const key = fold(name);
      if (!at.children.has(key)) at.children.set(key, node());
      at = at.children.get(key);
    }
  }
  // Records a path's spellings along the created folders it passes through, and stops where it leaves them.
  const mark = (file, present, old) => {
    let at = root;
    let from = 0;
    for (;;) {
      const end = file.indexOf('/', from);
      const name = end === -1 ? file.slice(from) : file.slice(from, end);
      at = at.children.get(fold(name));
      if (!at) return;
      const seen = at.spellings.get(name) ?? { present: false, old: false };
      at.spellings.set(name, { present: seen.present || present, old: seen.old || old });
      if (end === -1) return;
      from = end + 1;
    }
  };
  const isCreated = new Set(created);
  for (const file of all) mark(file, true, !isCreated.has(file));
  for (const file of created) mark(file, true, false);
  for (const file of deleted) mark(file, false, true);
  for (const file of created) {
    const names = file.split('/');
    let at = root;
    for (let depth = 0; depth < names.length; depth += 1) {
      at = at.children.get(fold(names[depth]));
      // A spelling that was already there is the user's, whatever else shares its folded name.
      if (at.spellings.get(names[depth]).old) continue;
      const others = [...at.spellings].filter(([name]) => name !== names[depth]);
      const staying = others.find(([, seen]) => seen.present);
      const going = others.find(([, seen]) => !seen.present);
      const other = staying ?? going;
      if (other) {
        return { path: file, rule: staying ? 'differs_only_in_case' : 'case_only_rename', other: [...names.slice(0, depth), other[0]].join('/') };
      }
    }
  }
  return null;
}

/**
 * The paths of a patch whose added lines hold a conflict marker, from one pass over the patch file.
 * An unfinished merge in a space comes out as content, so this is what the user is about to get in
 * their files. It is a text check and nothing more: a file that talks about merge markers counts too.
 */
async function conflictedPaths(patch) {
  const paths = [];
  let file = '';
  const lines = readline.createInterface({ input: createReadStream(patch), crlfDelay: Infinity });
  try {
    for await (const text of lines) {
      if (text.startsWith('+++ b/')) file = text.slice('+++ b/'.length);
      else if (file !== '' && text.startsWith('+<<<<<<< ')) {
        paths.push(file);
        file = '';
      }
    }
  } finally {
    lines.close();
  }
  return reported(paths);
}

/**
 * Paths for the caller to show: `count` is how many there are, and `paths` at most
 * `MAX_REPORTED_PATHS` of them with every control character replaced, because a path from a space is
 * text of the space's choosing and lands in a dialog. Counting comes first: a path the space names
 * with a newline must not make the warning disappear.
 */
const reported = (paths) => {
  const all = [...new Set(paths.filter((entry) => entry !== ''))];
  return { count: all.length, paths: all.slice(0, MAX_REPORTED_PATHS).map((entry) => entry.replace(new RegExp(EXT_UNCARRIABLE, 'g'), '?')) };
};

/**
 * The report of the snapshot script: the id of the commit it made, then `<mode> <object> <stage>\t<path>`
 * for every stage of every unmerged entry of the space's index, NUL separated. A piece without a tab
 * is not one of those and is dropped, a cut last one included.
 */
const readReport = (text) => {
  const report = String(text ?? '');
  const end = report.indexOf('\n');
  return {
    result: end === -1 ? '' : report.slice(0, end),
    unmerged: reported(report.slice(end + 1).split('\0').filter((entry) => entry.includes('\t')).map((entry) => entry.slice(entry.indexOf('\t') + 1))),
  };
};

/** `{ id, type, size }` for each line of `cat-file --batch-check`, in the order asked. A missing object is a failure. */
const parseSizes = (text) => text.split('\n').filter(Boolean).map((entry) => {
  const [id, type, size] = entry.split(' ');
  if (type === 'missing' || !/^\d+$/.test(size ?? '')) {
    throw new SpaceError('code_out_failed', `An object of the result is missing from the quarantine: ${id}`, { cause: 'object_missing' });
  }
  return { id, type, size: Number(size) };
});

/**
 * `git` is a host git from `createHostGit`, `place` the place the space lives on. `temporaryDirectory`
 * is where the quarantine repository, the patch and an empty hooks folder live while one call runs.
 * `removeDirectory` is how that folder goes, injectable so a test can make it fail.
 */
export function createCodeOut({ git, place, temporaryDirectory = os.tmpdir(), removeDirectory, platform = process.platform }) {
  const { withHostGit, requireGitVersion, requireWorkTree } = createTransferSession({ git, temporaryDirectory, removeDirectory, name: 'code out' });

  /** Runs `work`, and turns what it throws into what `bringCodeOut` rejects with, naming `step`. */
  const during = async (step, work) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SpaceError && OUT_CODES.has(error.code)) throw error;
      const ours = error instanceof SpaceError;
      const details = { step };
      if (ours) Object.assign(details, error.details);
      details.cause = error.code ?? null;
      throw new SpaceError('code_out_failed', ours ? error.message : `Code out failed on the host: ${error.message}`, details);
    }
  };

  /** The commit a ref names, read on the host, or null when there is no such ref. */
  const readRef = async (g, where, ref) => {
    const found = await g.run(where, ['rev-parse', '--verify', '--quiet', `${ref}^{object}`]);
    return found.code === 0 ? line(found.stdout) : null;
  };

  /** The space's start snapshot in this repository, which every comparison is made against. */
  const requireStart = async (g, top, spaceId) => {
    const start = await readRef(g, top, startRef(spaceId));
    if (!start) {
      throw new SpaceError('space_start_missing', `This repository holds no start snapshot for space ${spaceId}. The work of a space can come out only into the repository its code came from.`);
    }
    return start;
  };

  /** The result that `bringCodeOut` promoted for this space, or a refusal. */
  const requireResult = async (g, top, spaceId) => {
    const result = await readRef(g, top, resultRef(spaceId));
    if (!result) {
      throw new SpaceError('result_missing', `There is no result of space ${spaceId} in this repository yet. Bring the space's work out first.`);
    }
    return result;
  };

  /**
   * Fetches the space's result into the quarantine, under the host's deadline and a cap on what the
   * quarantine folder holds, polled while the fetch runs. Either ends the fetch's whole process tree,
   * and the rejection says which, whatever exit code the killed tree left: on Windows `taskkill`
   * leaves 1. `--update-shallow` is for this fetch only: while the space's repository is shallow,
   * before its history arrived or after that failed, a fetch without it printed a warning and exited
   * 0 without writing the ref.
   */
  const fetchIntoQuarantine = async (g, quarantine, url, timeoutMs, maxTransferBytes) => {
    const tooLarge = () => new SpaceError(
      'result_transfer_too_large',
      `The space sent more than ${maxTransferBytes} bytes, the limit of one transfer, so the transfer was stopped. Nothing reached the repository.`,
      { step: 'fetch into the quarantine', limit: maxTransferBytes },
    );
    const controller = new AbortController();
    let finished = false;
    // It never throws: it runs beside the fetch and nothing awaits it until the fetch is over, so a
    // failure of its own would be an unhandled rejection in the server.
    const watch = (async () => {
      try {
        while (!finished) {
          if (await folderBytes(quarantine) > maxTransferBytes) {
            controller.abort(tooLarge());
            return;
          }
          await pause(SIZE_POLL_MS);
        }
      } catch {
        // The cap after the fetch still holds, see below.
      }
    })();
    let fetched;
    try {
      fetched = await g.run(quarantine, [
        '-c', 'protocol.ext.allow=always', ...FETCH_CONFIG, ...QUARANTINE_CONFIG,
        'fetch', ...FETCH_FLAGS, '--update-shallow', url, `+${INSIDE_RESULT}:${QUARANTINE_RESULT}`,
      ], { timeoutMs, maxOutputBytes: FETCH_MAX_OUTPUT_BYTES, killTree: true, signal: controller.signal });
    } finally {
      finished = true;
      await watch;
    }
    // A fetch that finished between two polls is held to the same cap.
    if (await folderBytes(quarantine) > maxTransferBytes) throw tooLarge();
    if (fetched.code !== 0) {
      // The text comes from the space and from git's checks of its objects. It is shown, never parsed.
      throw new SpaceError('code_out_failed', `Fetching the result out of the space failed: ${tail(fetched.stderr) || `exit code ${fetched.code}`}`, { step: 'fetch into the quarantine', cause: null });
    }
  };

  /** `{ id, type, size }` by object id, for the ids given, read without inflating anything. */
  const sizesOf = async (g, where, ids) => new Map(parseSizes(await g.output(where, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    stdin: ids.map((id) => `${id}\n`).join(''),
    maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    timeoutMs: APPLY_TIMEOUT_MS,
  })).map((object) => [object.id, object]));

  /**
   * What one tree changes against another, counted and sized without inflating anything: the paths,
   * the bytes a patch between the two would read and write, which is both sides of every changed
   * path, deletions included, and the gitlinks among them. `where` is the repository that holds both,
   * the quarantine for the result against the start and the user's own for an apply.
   */
  const measureChange = async (g, where, from, to, { maxChangedBytes, maxChangedEntries }, refuse) => {
    let fields;
    try {
      fields = (await g.output(where, ['diff-tree', '-r', '-z', '--no-renames', from, to], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS })).split('\0');
    } catch (error) {
      if (error.code === 'command_output_too_large') throw refuse.tooMany(maxChangedEntries, 'paths');
      throw error;
    }
    const touched = [];
    const nested = [];
    const paths = [];
    const created = [];
    const deleted = [];
    let changedPaths = 0;
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [oldMode, newMode, oldId, newId, status] = fields[index].slice(1).split(' ');
      changedPaths += 1;
      paths.push(fields[index + 1]);
      if (status === 'A') created.push(fields[index + 1]);
      if (status === 'D') deleted.push(fields[index + 1]);
      // A gitlink names a commit that never travels: a repository the agent made inside its project.
      if (status !== 'D' && newMode === '160000') nested.push(fields[index + 1]);
      // Both sides count. A patch reads what is there now, a deletion included, and writes what comes:
      // measured with git 2.50.1, deleting one 431 MB file cost `diff-tree` 1.09 GB and `apply` 1.67 GB,
      // while the deletion itself brings no object at all.
      if (oldMode !== '160000' && !/^0+$/.test(oldId)) touched.push(oldId);
      if (status !== 'D' && newMode !== '160000') touched.push(newId);
    }
    if (changedPaths > maxChangedEntries) throw refuse.tooMany(maxChangedEntries, 'paths');
    const sizes = await sizesOf(g, where, [...new Set(touched)]);
    const changedBytes = touched.reduce((sum, id) => sum + sizes.get(id).size, 0);
    if (changedBytes > maxChangedBytes) throw refuse.tooLarge(changedBytes, maxChangedBytes);
    return { changedPaths, changedBytes, nestedRepositories: reported(nested), paths, created, deleted };
  };

  /**
   * Everything the result's history brings that the user does not have, counted and sized: no object
   * of it may be larger than `MAX_OBJECT_BYTES` unless it is a file, and together they must stay
   * within `maxChangedBytes`. A commit message and a tree weigh as much as a file and travel in a
   * pack of a few kilobytes, so neither the transfer cap nor the diff sees them. Runs in the
   * quarantine, which sees the start through its alternates, so nothing of this enters the user's
   * repository.
   */
  const measureHistory = async (g, quarantine, start, result, { maxChangedBytes, maxChangedEntries }, refuse) => {
    let fresh;
    try {
      fresh = (await g.output(quarantine, ['rev-list', '--objects', '--no-object-names', result, '--not', start], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS })).split('\n').filter(Boolean);
    } catch (error) {
      if (error.code === 'command_output_too_large') throw refuse.tooMany(maxChangedEntries, 'objects');
      throw error;
    }
    if (fresh.length > maxChangedEntries) throw refuse.tooMany(maxChangedEntries, 'objects');
    const sizes = await sizesOf(g, quarantine, fresh);
    let newBytes = 0;
    for (const id of fresh) {
      const object = sizes.get(id);
      newBytes += object.size;
      if (object.type !== 'blob' && object.size > MAX_OBJECT_BYTES) {
        throw new SpaceError(
          'result_too_large',
          `The work of the space holds a ${object.type} of ${object.size} bytes, more than the ${MAX_OBJECT_BYTES} bytes one of those may hold. Nothing reached the repository.`,
          { step: 'measure the result', limit: MAX_OBJECT_BYTES, objectType: object.type, objectBytes: object.size },
        );
      }
    }
    if (newBytes > maxChangedBytes) throw refuse.tooLarge(newBytes, maxChangedBytes);
    return { newBytes };
  };

  /**
   * The commit a fetch wrote to `ref` in `where`, read on the host and never taken from what the space
   * printed. A fetch can exit 0 without writing its ref: a shallow source it may not follow prints a
   * warning and nothing else. So a missing ref, or one that does not hold `expected`, is a failure.
   */
  const requireFetched = async (g, where, ref, step, expected) => {
    const found = await readRef(g, where, ref);
    if (!found || found !== expected) {
      throw new SpaceError('result_ref_missing', 'The result did not arrive, or is not the one the space said it made. Nothing was changed.', { step, cause: null });
    }
    return found;
  };

  /**
   * Brings the space's work out. Inside, a fixed script makes `refs/openchamber/result`: HEAD, with
   * one more commit on top that holds whatever is uncommitted, when something is. The agent's working
   * tree and index stay as they were. On the host, that result is fetched into a throwaway quarantine
   * repository with object checks, sized there against this space's start, and only then fetched
   * into the user's repository as `refs/openchamber/spaces/<id>/result`, which moves on a later call.
   * The quarantine goes on every path.
   *
   * `spacePath` is the one `bringCodeIn` returned. Resolves `{ result, changedPaths, changedBytes,
   * nestedRepositories, unmerged }`. The last two are what the caller has to warn about: repositories
   * the agent made inside its project, which arrive as a gitlink and nothing else, and paths the agent
   * left in a conflicted merge, whose conflict markers are in the result as ordinary content. Each is
   * `{ count, paths }`, with at most a hundred paths.
   */
  const bringCodeOut = (request) => withHostGit('code_out_failed', async (g, directory) => {
    const {
      repository, spaceId, spacePath: requestedPath, timeoutMs = FETCH_TIMEOUT_MS, innerMarginSeconds = INNER_MARGIN_SECONDS,
      maxTransferBytes = MAX_TRANSFER_BYTES, maxChangedBytes = MAX_CHANGED_BYTES, maxChangedEntries = MAX_CHANGED_ENTRIES,
    } = request ?? {};
    requireSpaceId(spaceId);
    const spacePath = requireSpaceProjectPath(spaceId, requestedPath);
    requireTimeout(timeoutMs);
    requireInnerMargin(innerMarginSeconds);
    const limits = { maxTransferBytes, maxChangedBytes, maxChangedEntries };
    for (const name of LIMIT_NAMES) requireLimit(limits[name], name);
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    const start = await requireStart(g, top, spaceId);
    const objectFormat = line(await g.output(top, ['rev-parse', '--show-object-format']));

    // Asked first: it refuses a space that is gone, stopped or not ours before anything runs inside.
    const execArgv = await during('reach the space', () => place.execArgv(spaceId));
    const reportedByTheSpace = await during('snapshot the space', async () => {
      const seconds = innerSeconds(SNAPSHOT_TIMEOUT_MS, innerMarginSeconds);
      const snapshot = await place.exec(spaceId, [
        IMAGE_TIMEOUT, '-s', 'KILL', String(seconds), IMAGE_SH, '-c', SNAPSHOT_SCRIPT, 'sh',
        spacePath, UNCOMMITTED_MESSAGE, SNAPSHOT_IDENTITY.GIT_COMMITTER_NAME, SNAPSHOT_IDENTITY.GIT_COMMITTER_EMAIL,
      ], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
      if (snapshot.code !== 0) {
        throw new SpaceError('code_out_failed', `Could not take the snapshot inside the space: ${tail(snapshot.stderr) || `exit code ${snapshot.code}`}`, { step: 'snapshot the space', cause: 'inside_command_failed', exitCode: snapshot.code });
      }
      const report = readReport(snapshot.stdout);
      if (!objectIdPattern(objectFormat).test(report.result)) {
        throw new SpaceError('code_out_failed', 'The space did not say which commit its snapshot made.', { step: 'snapshot the space', cause: 'inside_command_failed' });
      }
      return report;
    });

    // The quarantine reads the user's objects through alternates and copies none, so the space sends
    // only what the user does not have, and a failed or killed fetch leaves its partial pack here.
    const quarantine = path.join(directory, 'quarantine.git');
    const result = await during('fetch into the quarantine', async () => {
      await g.output(directory, ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, quarantine]);
      const objects = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-path', 'objects'])));
      await fs.mkdir(path.join(quarantine, 'objects', 'info'), { recursive: true });
      await fs.writeFile(path.join(quarantine, 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`);
      const url = buildExtUrl([...execArgv, IMAGE_TIMEOUT, '-s', 'KILL', String(innerSeconds(timeoutMs, innerMarginSeconds)), IMAGE_GIT, 'upload-pack', spacePath]);
      await fetchIntoQuarantine(g, quarantine, url, timeoutMs, maxTransferBytes);
      // Exactly the commit the snapshot said it made. Between the snapshot and the fetch the space can
      // move its own ref, and everything the host reports about unmerged paths belongs to that one commit.
      const fetched = await requireFetched(g, quarantine, QUARANTINE_RESULT, 'fetch into the quarantine', reportedByTheSpace.result);
      if (line(await g.output(quarantine, ['cat-file', '-t', fetched])) !== 'commit') {
        throw new SpaceError('result_not_a_commit', 'What the space offered as its result is not a commit. Nothing was changed.', { step: 'fetch into the quarantine' });
      }
      return fetched;
    });
    const summary = await during('measure the result', async () => {
      const refuse = {
        tooMany: (limit, what) => new SpaceError('result_too_many_changes', `The work of the space changes more than ${limit} ${what}, the limit of one result. Nothing reached the repository.`, { step: 'measure the result', limit }),
        tooLarge: (bytes, limit) => new SpaceError('result_too_large', `The work of the space brings ${bytes} bytes, more than the limit of ${limit}. Nothing reached the repository.`, { step: 'measure the result', limit, newBytes: bytes }),
      };
      // What the history brings is what the user's repository keeps, so it is what is capped here.
      // What a patch of it would cost is measured again by `applyAsChanges`, where it is paid.
      const { newBytes } = await measureHistory(g, quarantine, start, result, limits, refuse);
      const { paths, created, deleted, ...change } = await measureChange(g, quarantine, start, result, { ...limits, maxChangedBytes: Number.MAX_SAFE_INTEGER }, refuse);
      return { ...change, newBytes };
    });

    // Into the user's repository, from the quarantine, with the same checks and without
    // `--update-shallow`: the user's repository never becomes shallow.
    await during('promote the result', async () => {
      const promoted = await g.run(top, [
        ...FETCH_CONFIG, 'fetch', ...FETCH_FLAGS, quarantine.replaceAll('\\', '/'), `+${QUARANTINE_RESULT}:${resultRef(spaceId)}`,
      ], { timeoutMs, maxOutputBytes: FETCH_MAX_OUTPUT_BYTES, killTree: true });
      if (promoted.code !== 0) {
        throw new SpaceError('code_out_failed', `Taking the result into the repository failed: ${tail(promoted.stderr) || `exit code ${promoted.code}`}`, { step: 'promote the result', cause: null });
      }
      await requireFetched(g, top, resultRef(spaceId), 'promote the result', result);
    });
    return { result, ...summary, unmerged: reportedByTheSpace.unmerged };
  });

  /** A branch name git accepts, taken as it is: `check-ref-format --branch` also expands `@{-1}`, which must not pass. */
  const requireBranchName = async (g, top, branch) => {
    const text = String(branch ?? '');
    const refused = () => new SpaceError('invalid_branch_name', 'That name is not one git accepts for a new branch.');
    // Only the name as it was given: a number or anything else that turns into text is refused.
    if (text !== branch || text === '' || text.startsWith('-') || EXT_UNCARRIABLE.test(text)) throw refused();
    const check = await g.run(top, ['check-ref-format', '--branch', text]);
    if (check.code !== 0 || line(check.stdout) !== text) throw refused();
    return text;
  };

  /**
   * Makes the new branch `refs/heads/<branch>` at the result, with the agent's commits and, on top,
   * the uncommitted changes of the space as one commit when there were any. Nothing is checked out:
   * the working tree, the index and HEAD stay as they are, and no program of the user's runs. An
   * existing branch is refused and never moved. Resolves `{ branch, commit }`.
   */
  const applyAsBranch = (request) => withHostGit('code_out_failed', async (g, directory) => {
    const { repository, spaceId, branch } = request ?? {};
    requireSpaceId(spaceId);
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    const name = await requireBranchName(g, top, branch);
    const result = await requireResult(g, top, spaceId);
    const objectFormat = line(await g.output(top, ['rev-parse', '--show-object-format']));
    const exists = () => new SpaceError('branch_exists', `A branch named ${name} already exists. Choose another name; the existing branch was not changed.`);
    if (await readRef(g, top, `refs/heads/${name}`)) throw exists();
    // Against the zero id, so a branch that appeared in between is never moved.
    const created = await g.run(top, ['update-ref', '-m', `openchamber: work of space ${spaceId}`, `refs/heads/${name}`, result, zeroObjectId(objectFormat)]);
    if (created.code !== 0) {
      if (await readRef(g, top, `refs/heads/${name}`)) throw exists();
      throw new SpaceError('git_command_failed', `Could not create the branch ${name}: ${tail(created.stderr) || `exit code ${created.code}`}`, { exitCode: created.code });
    }
    return { branch: name, commit: result };
  });

  /** A boolean setting of this repository, false when it is not set. */
  const readSetting = async (g, top, key) => line((await g.run(top, ['config', '--bool', '--get', key])).stdout) === 'true';

  const exists = (full) => fs.lstat(full).then(() => true, () => false);

  /**
   * What an apply that was interrupted left in the working tree, for the paths of the patch from `from`
   * to `to`: `finished` when every path holds what `to` has, `not_started` when every path still holds
   * what `from` has, and `partly` otherwise. The contents are compared the way `git status` compares
   * them, through a temporary index of just those paths, so the user's own filters apply as they do
   * for them. Nothing of the user's is written.
   */
  const interruptedApplyState = async (g, directory, top, from, to) => {
    const fields = (await g.output(top, ['diff-tree', '-r', '-z', '--no-renames', from, to], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS })).split('\0');
    const entries = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [oldMode, newMode, oldId, newId] = fields[index].slice(1).split(' ');
      entries.push({ path: fields[index + 1], sides: { from: { mode: oldMode, id: oldId }, to: { mode: newMode, id: newId } } });
    }
    const holds = async (side) => {
      for (const entry of entries) {
        if (entry.sides[side].mode === '000000' && await exists(path.join(top, ...entry.path.split('/')))) return false;
      }
      // A gitlink never travels, so there is nothing of it to compare.
      const present = entries.filter((entry) => !['000000', '160000'].includes(entry.sides[side].mode));
      if (present.length === 0) return true;
      const env = { GIT_INDEX_FILE: path.join(directory, `interrupted-${side}.index`) };
      const unsplit = ['-c', 'core.splitIndex=false'];
      await g.output(top, [...unsplit, 'update-index', '-z', '--index-info'], {
        env, stdin: present.map((entry) => `${entry.sides[side].mode} ${entry.sides[side].id}\t${entry.path}\0`).join(''), timeoutMs: APPLY_TIMEOUT_MS,
      });
      await g.run(top, [...unsplit, 'update-index', '-q', '--refresh'], { env, timeoutMs: APPLY_TIMEOUT_MS });
      const differing = await g.output(top, [...unsplit, 'diff-files', '--name-only', '-z'], { env, maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS });
      return differing === '';
    };
    if (await holds('to')) return 'finished';
    if (await holds('from')) return 'not_started';
    return 'partly';
  };

  /**
   * Where this space stands for an apply as uncommitted changes, read and nothing else: whether that
   * route is `open` or `closed`, the result the last apply wrote (`lastApplied`, or null), the result
   * that is there now (`result`, or null before any bring-out), how many paths an apply would write
   * now (`newPaths`, or null without a result), and whether an earlier apply was interrupted
   * (`interruptedApply`), which the next apply sorts out before anything else.
   */
  const describeApplyState = (request) => withHostGit('code_out_failed', async (g, directory) => {
    const { repository, spaceId } = request ?? {};
    requireSpaceId(spaceId);
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    const start = await requireStart(g, top, spaceId);
    const result = await readRef(g, top, resultRef(spaceId));
    const lastApplied = await readRef(g, top, appliedRef(spaceId));
    const closed = await readRef(g, top, closedRef(spaceId));
    let newPaths = null;
    if (result) {
      const names = await g.output(top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', lastApplied ?? start, result], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS });
      newPaths = names.split('\0').filter(Boolean).length;
    }
    return {
      changesRoute: closed ? 'closed' : 'open',
      result,
      lastApplied,
      newPaths,
      interruptedApply: (await readRef(g, top, applyingRef(spaceId))) !== null,
    };
  });

  /**
   * Applies what the space changed to the working tree as uncommitted changes. The patch is built on
   * the host into a file and applied at the top level of the work tree after a dry run. The index is
   * not touched.
   *
   * It starts from what the last apply of this space wrote, `refs/openchamber/spaces/<id>/applied`,
   * and from the space's start when there was none. So a second apply, after the agent worked on and
   * the work came out again, brings only what is new since the first one, and applying the same result
   * twice has nothing to apply. That ref is written only once the apply has gone through; when writing
   * it fails afterwards the changes are in the working tree all the same, and `remembered` is false.
   *
   * A dry run that fails is `changes_do_not_apply` and nothing was touched. A real apply that fails
   * after a clean dry run, for a folder that cannot be written or a disk that is full, is
   * `changes_partly_applied`: part of the work may be in the working tree, and the remembered ref is
   * not moved, because it no longer describes what is there.
   *
   * Either of those closes this route for the space, as `refs/openchamber/spaces/<id>/changes-closed`:
   * the user's project and the agent's work have gone apart, and every later call refuses at once with
   * `changes_route_closed`, before any patch is built. `applyAsBranch` keeps working and closes
   * nothing. Nothing in this stage opens the route again.
   *
   * Resolves `{ status: 'applied', appliedPaths, remembered, nestedRepositories, conflicted }`, or
   * `{ status: 'nothing_to_apply' }`. `appliedPaths` counts the paths this call wrote, which is not
   * `changedPaths` of `bringCodeOut`: that one counts against the space's start.
   */
  const applyAsChanges = (request) => withHostGit('code_out_failed', async (g, directory) => {
    const { repository, spaceId, maxChangedBytes = MAX_CHANGED_BYTES, maxChangedEntries = MAX_CHANGED_ENTRIES } = request ?? {};
    requireSpaceId(spaceId);
    requireLimit(maxChangedBytes, 'maxChangedBytes');
    requireLimit(maxChangedEntries, 'maxChangedEntries');
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    const start = await requireStart(g, top, spaceId);
    const result = await requireResult(g, top, spaceId);
    // What the last apply of this space put there, or its start when there was no apply.
    if (await readRef(g, top, closedRef(spaceId))) {
      throw new SpaceError(
        'changes_route_closed',
        `The work of this space is no longer applied as uncommitted changes: it and your project went apart. ${BRANCH_FROM_NOW_ON}`,
      );
    }
    // Written before a refusal below leaves, so a later call refuses at once.
    const close = (at = result) => g.run(top, ['update-ref', '-m', `openchamber: the work of space ${spaceId} is applied as a branch now`, closedRef(spaceId), at]);
    let applied = await readRef(g, top, appliedRef(spaceId));
    // An earlier apply was interrupted: the host went away between writing the files and the record.
    const applying = await readRef(g, top, applyingRef(spaceId));
    if (applying) {
      const state = await interruptedApplyState(g, directory, top, applied ?? start, applying);
      if (state === 'partly') {
        await close(applying);
        await g.run(top, ['update-ref', '-d', applyingRef(spaceId), applying]);
        throw new SpaceError(
          'changes_partly_applied',
          `An earlier apply of the work of this space was interrupted, and part of it is in your project: look at what changed. Your project is now in a state this cannot reason about. ${BRANCH_FROM_NOW_ON}`,
          { interrupted: true },
        );
      }
      const record = state === 'finished'
        ? `update ${appliedRef(spaceId)} ${applying}\ndelete ${applyingRef(spaceId)} ${applying}\n`
        : `delete ${applyingRef(spaceId)} ${applying}\n`;
      await g.output(top, ['update-ref', '-m', `openchamber: sorted out an interrupted apply of space ${spaceId}`, '--stdin'], { stdin: record });
      if (state === 'finished') applied = applying;
    }
    const from = applied ?? start;
    // What this patch would read and write, measured here because this is where it is paid, and for
    // a pair `bringCodeOut` never saw: the result against the last apply.
    const tooLarge = (what) => new SpaceError(
      'changes_too_large',
      `The work of the space is too large to apply as uncommitted changes: it would ${what}. Nothing was changed. Apply it as a branch instead.`,
      { limit: maxChangedBytes },
    );
    const refuse = {
      tooMany: (limit, what) => tooLarge(`change more than ${limit} ${what}`),
      tooLarge: (bytes, limit) => tooLarge(`read and write ${bytes} bytes, more than the limit of ${limit}`),
    };
    const change = await measureChange(g, top, from, result, { maxChangedBytes, maxChangedEntries }, refuse);
    if (change.changedPaths === 0) {
      return { status: 'nothing_to_apply' };
    }
    // A name the agent made that this computer cannot hold. Not a sign that the two went apart: after
    // the agent renames it, the next bring-out applies as usual, so the route stays open.
    const names = {
      ignoreCase: await readSetting(g, top, 'core.ignorecase'),
      precompose: await readSetting(g, top, 'core.precomposeunicode'),
    };
    if (change.created.length > 0) {
      const all = names.ignoreCase || names.precompose
        ? (await g.output(top, ['ls-tree', '-r', '-z', '--name-only', result], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES })).split('\0').filter(Boolean)
        : [];
      const unholdable = nameNotAllowedHere(change.created, all, {
        platform, ...names, deleted: change.deleted, top, longPaths: await readSetting(g, top, 'core.longpaths'),
      });
      if (unholdable !== null) {
        const [shown, other] = reported([unholdable.path, unholdable.other ?? '']).paths;
        const details = { path: shown, rule: unholdable.rule, other: other ?? null };
        if (unholdable.rule === 'case_only_rename') {
          throw new SpaceError(
            'case_only_rename',
            `The agent renamed ${other} to ${shown}, changing only the case of the name, and on this computer that cannot be applied as uncommitted changes, so nothing was changed. The branch holds it: apply the work as a branch, or have the agent choose a new name and bring the work out again.`,
            details,
          );
        }
        const why = unholdable.rule === 'differs_only_in_case'
          ? `differs from ${other} only in case, and this computer takes the two for one file`
          : 'has a name this computer cannot hold';
        throw new SpaceError(
          'name_not_allowed_here',
          `The agent made ${shown}, which ${why}, so nothing was changed. Have the agent rename it, then bring the work out again.`,
          details,
        );
      }
    }
    // Checked here and not left to git, before anything is built or written.
    const redirected = await firstRedirectedFolder(top, change.paths, names);
    if (redirected !== null) {
      await close();
      throw new SpaceError(
        'changes_blocked_by_link',
        `The work of the space writes into ${reported([redirected]).paths[0]}, which in your project is a link to another place, so nothing was changed. ${BRANCH_FROM_NOW_ON}`,
        { path: reported([redirected]).paths[0] },
      );
    }
    const patch = path.join(directory, 'result.patch').replaceAll('\\', '/');
    try {
      await g.output(top, [...PATCH_ARGS, `--output=${patch}`, from, result], { timeoutMs: APPLY_TIMEOUT_MS });
    } catch (error) {
      // git refuses to build a diff it cannot hold, for one huge file among others.
      throw new SpaceError(
        'patch_not_possible',
        `A patch of the work of the space could not be built, so nothing was changed. Apply it as a branch instead. Git said: ${error.message}`,
        { cause: error.code ?? null },
      );
    }
    const check = await g.run(top, [...APPLY_ARGS, '--check', patch], { timeoutMs: APPLY_TIMEOUT_MS });
    if (check.code !== 0) {
      // A file the user keeps out of git, by a global ignore file or info/exclude, that the space also
      // made: it was there before the space, so "your project changed" would not be true.
      const inTheWay = [];
      for (const file of change.created) {
        if (await exists(path.join(top, ...file.split('/')))) inTheWay.push(file);
      }
      const ignored = inTheWay.length === 0 ? [] : (await g.run(top, ['check-ignore', '-z', '--stdin'], { stdin: inTheWay.map((file) => `${file}\0`).join('') })).stdout.split('\0').filter(Boolean);
      await close();
      const said = `Git said: ${tail(check.stderr) || `exit code ${check.code}`}`;
      if (ignored.length > 0) {
        throw new SpaceError(
          'changes_do_not_apply',
          `Your project already has ${reported(ignored).paths[0]}, which git ignores here, and the work of the space adds a file of the same name, so nothing was changed. ${BRANCH_FROM_NOW_ON} ${said}`,
          { exitCode: check.code, ignoredInTheWay: reported(ignored) },
        );
      }
      const since = applied ? 'since its work was last applied here' : 'since the space was made';
      throw new SpaceError(
        'changes_do_not_apply',
        `The work of the space does not fit your project any more: your project changed ${since}, so nothing was changed now. ${BRANCH_FROM_NOW_ON} ${said}`,
        { exitCode: check.code },
      );
    }
    // The intent, before anything is written: a later call that finds it knows an apply was under way.
    await g.output(top, ['update-ref', '-m', `openchamber: applying the work of space ${spaceId}`, applyingRef(spaceId), result]);
    const done = await g.run(top, [...APPLY_ARGS, patch], { timeoutMs: APPLY_TIMEOUT_MS });
    if (done.code !== 0) {
      // The dry run passed and this did not, so some of the changes may be in the working tree. The
      // remembered ref stays where it was, because it no longer describes what is there.
      await close();
      await g.run(top, ['update-ref', '-d', applyingRef(spaceId), result]);
      throw new SpaceError(
        'changes_partly_applied',
        `Applying the work of the space stopped in the middle, so part of it may be in your project already: look at what changed. Your project is now in a state this cannot reason about. ${BRANCH_FROM_NOW_ON} Git said: ${tail(done.stderr) || `exit code ${done.code}`}`,
        { exitCode: done.code },
      );
    }
    // Only now, with the changes in the working tree: the next apply starts from here. When this fails,
    // the intent stays, and the next call finds the work in the working tree and finishes the record.
    const remembered = await g.run(top, ['update-ref', '-m', `openchamber: applied the work of space ${spaceId}`, '--stdin'], {
      stdin: `update ${appliedRef(spaceId)} ${result}\ndelete ${applyingRef(spaceId)} ${result}\n`,
    });
    return {
      status: 'applied',
      appliedPaths: change.changedPaths,
      remembered: remembered.code === 0,
      nestedRepositories: change.nestedRepositories,
      conflicted: await conflictedPaths(patch),
    };
  });

  return { bringCodeOut, applyAsBranch, applyAsChanges, describeApplyState };
}
