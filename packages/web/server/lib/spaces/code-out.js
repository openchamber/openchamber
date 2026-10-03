// Code out: the result of a space travels back to the user's repository as git objects over the
// place's exec channel, and is applied there as a branch or as uncommitted changes. The host drives
// every step. The command sequences follow docs/isolated-spaces/stage-0/e4-git-over-exec.md.
//
// Everything that comes out of a space is untrusted data. The space can send hostile objects, send
// without end, hang, lie about its history, or print a lot. Its objects land in a throwaway
// quarantine repository first and are checked there; the user's repository gets them only after
// that, and the patch that is applied is built on the host from two trees it holds.

import crypto from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
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
// How deep, in all, the changed paths and their folders may lie for an apply as uncommitted changes,
// per entry of the cap above: 3.2 million steps from a folder into the next by default. An ordinary
// large change is far below it: twenty thousand files three folders deep, each in folders of its own,
// is 180,000, and a hundred thousand files twelve deep in twenty thousand folders about 1.4 million.
// What it allows at most was measured on macOS, see the measurement notes in DOCUMENTATION.md.
const FOLDER_STEPS_PER_ENTRY = 32;
// A quiet fetch prints nothing. What it does print comes from the space.
const FETCH_MAX_OUTPUT_BYTES = 1024 * 1024;
const LIST_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// What a `git apply` keeps of what it prints: the end of it, for the message. The exit code is the
// answer, so a check that prints a line for each of a hundred thousand paths must not fail for that.
const APPLY_OUTPUT_TAIL_BYTES = 64 * 1024;
// How long one call may spend reading the working tree back, to tell whether the user kept or threw
// away the last apply and where an interrupted one stopped. Every file of the last apply is read, by
// its bytes, and through the user's clean filters where the bytes are neither side's: measured by a
// reviewer on the seventh round, which read every file through the filters, a hundred thousand files
// took 6.9 s, and 276 s with a clean filter that starts a program per file. Past this the call answers
// `changes_undecided` instead of failing on every later call.
const READ_BACK_TIMEOUT_MS = 5 * 60_000;
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
// What the patch of the last apply was built from, beside `applied`, and of the apply under way, beside
// `applying`: the start, or the apply before it. Each moves with its partner in one transaction. When
// the user threw the last apply away, every path it changed is back as this ref has it, and the next
// apply brings the whole work again from here. A repository without it, from before, never does.
const appliedFromRef = (spaceId) => `${spaceRefPrefix(spaceId)}applied-from`;
const applyingFromRef = (spaceId) => `${spaceRefPrefix(spaceId)}applying-from`;
// The commit the user's HEAD named when the last apply wrote, beside `applied`, and when the apply under
// way began, beside `applying`, moving with them in the same transactions; absent while HEAD had no
// commit yet. A path of the last apply that a commit of the user's changed since, from this commit to
// the HEAD of the working tree, is the user's own change and never thrown away; see `whatBecameOf`.
const appliedHeadRef = (spaceId) => `${spaceRefPrefix(spaceId)}applied-head`;
const applyingHeadRef = (spaceId) => `${spaceRefPrefix(spaceId)}applying-head`;
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
// everything the script runs writes to /dev/null instead and runs with descriptor 3 closed, so what
// git and the agent's hooks print does not land in the report, and a hook cannot write to it through
// the descriptors it inherits. That keeps the report readable; it does not keep it private. A process
// of the agent's reaches the channel all the same on Linux, through /proc: the shell keeps a copy of
// descriptor 3 while the block runs (dash on fd 10), and /proc/<pid>/fd opens it for the same user.
// Only the two commands at the end write the report. The report is the id of the commit the script
// made, then the unmerged entries of the space's index, read before `add --all` stages their
// conflicted content. It is data from the space and is treated as such: the host takes the id only to
// require that exact object from the fetch, which checks it like any result, and the paths only to
// show. A report the agent wrote itself can name another commit of its own, which the agent could as
// well have made its result, and paths that do not belong to it.
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

// Reading the working tree back: how many files are read at once, and how much of one file is held at
// a time. A file is hashed as it is read and never held whole.
const READ_AT_ONCE = 8;
const READ_PIECE_BYTES = 64 * 1024;

/** The id git gives `bytes` as a blob, in the repository's hash `algorithm`. */
const blobId = (algorithm, bytes) => crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

// What `hashFile` answers for a file that changed size while it was read: an editor saving it at that
// moment. `lookAt` reads it again a few times before it gives up on it.
const CHANGED_WHILE_READ = Symbol('changed while read');
// How many times one file is read before a file that keeps changing is answered as undecided, and the
// pause between two reads. Within the call's time like every read.
const READS_OF_A_CHANGING_FILE = 4;
const PAUSE_BETWEEN_READS_MS = 100;

/**
 * The id git would give the bytes of the file at `full` as a blob, read a piece at a time and never
 * whole; null when it cannot be read as one plain file: the open or a read fails, or what was opened
 * is no plain file, a link swapped in included, which is never followed; `CHANGED_WHILE_READ` when it
 * changed size while it was read. The open does not wait: a FIFO swapped in after the `lstat` would otherwise hold the call in
 * an open that never returns, where no deadline is checked. Past `until` it rejects with
 * `command_timeout`, as a git command past its time would. `files` is `node:fs/promises`, or what a
 * test hands in instead.
 */
async function hashFile(files, full, algorithm, until) {
  let handle;
  try {
    handle = await files.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const hash = crypto.createHash(algorithm).update(`blob ${stats.size}\0`);
    const piece = Buffer.allocUnsafe(Math.max(1, Math.min(READ_PIECE_BYTES, stats.size)));
    let total = 0;
    for (;;) {
      if (Date.now() > until) throw new SpaceError('command_timeout', 'Reading a file of the working tree back did not end in time');
      const { bytesRead } = await handle.read(piece, 0, piece.length, null).catch(() => ({ bytesRead: -1 }));
      if (bytesRead < 0) return null;
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > stats.size) return CHANGED_WHILE_READ;
      hash.update(piece.subarray(0, bytesRead));
    }
    return total === stats.size ? hash.digest('hex') : CHANGED_WHILE_READ;
  } finally {
    await handle.close();
  }
}

// Applies as uncommitted changes, and reads of where one stands, under way in this process, by
// repository and space: the promise the next one waits for. Two applies of one space at once each
// passed the dry run against the same working tree, then the second wrote over the first and found
// its patch no longer fitting, and closed the route. One waits for the other now, and then answers
// from what the first left: nothing to apply, or only what is new. At module level, so two
// `createCodeOut` instances share it, as the history runs of code in are shared. Two processes are
// not coordinated.
const applyTurns = new Map();

/** Runs `work` once every earlier call with the same `key` in this process has ended, however it ended. */
const inTurn = async (key, work) => {
  const earlier = applyTurns.get(key);
  let done;
  const mine = new Promise((resolve) => { done = resolve; });
  applyTurns.set(key, mine);
  try {
    await earlier;
    return await work();
  } finally {
    done();
    if (applyTurns.get(key) === mine) applyTurns.delete(key);
  }
};

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
 *
 * The fold is wider than `toLowerCase` on purpose. APFS folds case fully, so `strasse` and `straße`,
 * `σ` and `ς`, `fi` and `ﬁ`, `s` and `ſ`, `β` and `ϐ` are one name there, checked on this Mac's disk
 * by a test; lowering alone keeps each pair apart, and a file was lost. Lower, upper, lower again
 * joins them, `ẞ` with `ss` included, which upper-then-lower alone misses. APFS also ignores the
 * Unicode form wherever it ignores case, so a case-blind fold composes too. NTFS compares names
 * through a table that upcases one UTF-16 unit at a time, which is narrower: `ß` and `ss` are two
 * names there. Folding wider than the disk can only make more names meet. In `nameNotAllowedHere`
 * that refuses more and never lets a lost file through. In `firstRedirectedFolder` it lets a real
 * path pass as the same folder when it differs from git's spelling by more than the disk's own fold.
 * By reasoning, not by a test: a real path names a different folder only through a link, which
 * `lstat` reports before any name is compared, or through a Windows volume mount point, whose real
 * path names another volume and so is not inside the work tree under any fold.
 */
const nameFolder = ({ ignoreCase, precompose }) => (name) => {
  if (!ignoreCase) return precompose ? name.normalize('NFC') : name;
  return name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
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
 * them. A link the patch itself deletes, `deletedLinks`, is not in the way either: `git apply` removes
 * it before it makes the folder, and its dry run first requires the link on disk to be the one the
 * patch deletes. Only a link the patch deletes as a link is passed over, never a folder or a file.
 *
 * Each folder is looked at once with `lstat`. The real path is asked once per path, of its deepest
 * folder that exists, because that one answer covers every folder above it; only when it does not
 * match is each folder on the way asked, to name the first that leads elsewhere. How many folders
 * that is, is bounded before this runs: `measureChange` refuses a change through more folders than
 * the entries cap. `lstat` and `realpath` are for the tests, which cannot build every kind of
 * redirection on every system.
 */
export async function firstRedirectedFolder(top, paths, { ignoreCase = false, precompose = false, deletedLinks = [], lstat = fs.lstat, realpath = fs.realpath } = {}) {
  const root = await realpath(top);
  const fold = nameFolder({ ignoreCase, precompose });
  const kinds = new Map();
  const reals = new Map();
  const goingLinks = new Set(deletedLinks);
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
          // A link the patch deletes goes before the folder comes, so there is nothing below it yet.
          if (stats.isSymbolicLink()) kind = goingLinks.has(relative) ? 'absent' : 'link';
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
//   MAX_PATH is 260 including the terminating null; Git for Windows lifts it with that setting);
// - a whole path of a folder longer than 247 characters, unless the repository has `core.longpaths`
//   (Microsoft, CreateDirectory: "the default string size limit for paths is 248 characters"
//   (MAX_PATH - 12, room for an 8.3 file name), that null included; Git for Windows' `mingw_mkdir`
//   converts the path with a limit of 248 where every other call has MAX_PATH).
// macOS and Linux refuse only NUL and `/` in a name, and neither can come out of a git tree. On every
// platform a name longer than 255 bytes is refused, the longest name ext4, APFS and NTFS hold, and a
// path of 1024 bytes or more, the project's own path in front of it included: 1024 is macOS's
// PATH_MAX, the smallest of the three systems, and counts the terminating null. Without the project's
// path, a path within the limit below the project still ended in `ENAMETOOLONG` on the host. `git apply`
// itself writes such a path, working below the project, but the file is then out of reach of anything
// that opens it by its whole path, the test's own clean-up among them, measured on macOS. Those two
// are also what keep the check below cheap. Names that differ only in case are one file where the
// repository says so; see `nameNotAllowedHere`.
const WINDOWS_RESERVED_CHARACTER = /[<>:"/\\|?*\x01-\x1f]/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[0-9¹²³]) *(?:[.:]|$)/i;
const WINDOWS_TRAILING = /[ .]$/;
const WINDOWS_MAX_PATH = 259;
const WINDOWS_MAX_FOLDER_PATH = 247;
const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 1023;

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
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const file of created) {
    const whole = top === '' ? file : join(top, file);
    if (Buffer.byteLength(whole) > MAX_PATH_BYTES) return { path: file, rule: 'path_too_long', other: null };
    if (platform === 'win32' && !longPaths && top !== '') {
      if (whole.length > WINDOWS_MAX_PATH) return { path: file, rule: 'path_too_long', other: null };
      // The folder the file goes into, which apply may have to make, the deepest and longest of them.
      const folder = file.includes('/') ? join(top, file.slice(0, file.lastIndexOf('/'))) : '';
      if (folder.length > WINDOWS_MAX_FOLDER_PATH) return { path: file, rule: 'path_too_long', other: null };
    }
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
 * `removeDirectory` is how that folder goes, injectable so a test can make it fail. `readBackTimeoutMs`
 * bounds the time one apply or read of its state spends reading the working tree back, see
 * `READ_BACK_TIMEOUT_MS`. `files` is how the working tree is read back, `node:fs/promises` unless a
 * test counts what is read.
 */
export function createCodeOut({ git, place, temporaryDirectory = os.tmpdir(), removeDirectory, platform = process.platform, readBackTimeoutMs = READ_BACK_TIMEOUT_MS, files = fs }) {
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

  /** The raw `diff-tree -z` listing of what `to` changes against `from`, as fields: the status line, then the path. */
  const listChange = async (g, where, from, to) => (await g.output(where, ['diff-tree', '-r', '-z', '--no-renames', from, to], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS })).split('\0');

  /**
   * What one tree changes against another, counted and sized without inflating anything: the paths,
   * the folders they pass through, the bytes a patch between the two would read and write, which is
   * both sides of every changed path, deletions included, and the gitlinks among them. `where` is the
   * repository that holds both, the quarantine for the result against the start and the user's own
   * for an apply. `maxFolders` and `maxFolderSteps` are the caps on the folders, see below.
   */
  const measureChange = async (g, where, from, to, { maxChangedBytes, maxChangedEntries, maxFolders, maxFolderSteps }, refuse, list = () => listChange(g, where, from, to)) => {
    let fields;
    try {
      fields = await list();
    } catch (error) {
      if (error.code === 'command_output_too_large') throw refuse.tooMany(`changes so many paths that their list is longer than ${LIST_MAX_OUTPUT_BYTES} bytes`, LIST_MAX_OUTPUT_BYTES);
      throw error;
    }
    const touched = [];
    const nested = [];
    const paths = [];
    const created = [];
    const deleted = [];
    const deletedLinks = [];
    let changedPaths = 0;
    // The folders the changed paths pass through, a cost the paths and bytes do not show. Twenty
    // thousand files five hundred folders deep brought only 503 objects and passed every other cap,
    // and the checks before an apply then ran Node out of memory. Two counts, both in this one pass:
    // - `folders`, each folder once: the host keeps a node for each while it checks names and links,
    //   so this is what bounds its memory;
    // - `steps`, how deep each of them and each path lies: every look at a folder and every file git
    //   writes goes from the top of the work tree down, one folder at a time, so this is what bounds
    //   the time. Measured on macOS under the folder cap alone: 95,520 files in 95,520 folders, 480
    //   deep, took the checks 173 s and `git apply` 148 s for its dry run and 307 s for the apply.
    // diff-tree lists the paths of one folder together, so a folder is counted when a path enters it
    // and not again for the paths inside it that follow. A listing in another order would count a
    // folder again, which refuses sooner and never lets more through. Counting holds one path.
    let folders = 0;
    let steps = 0;
    let previous = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [oldMode, newMode, oldId, newId, status] = fields[index].slice(1).split(' ');
      const file = fields[index + 1];
      changedPaths += 1;
      if (changedPaths > maxChangedEntries) throw refuse.tooMany(`changes more than ${maxChangedEntries} paths`, maxChangedEntries);
      const names = file.split('/').slice(0, -1);
      let shared = 0;
      while (shared < names.length && shared < previous.length && names[shared] === previous[shared]) shared += 1;
      folders += names.length - shared;
      // The depths of the folders entered here, shared + 1 to names.length, and the path's own.
      steps += (names.length * (names.length + 1) - shared * (shared + 1)) / 2 + names.length;
      if (folders > maxFolders) throw refuse.tooMany(`changes files in more than ${maxFolders} folders`, maxFolders);
      if (steps > maxFolderSteps) throw refuse.tooMany(`changes files so deep among so many folders that reaching them all takes more than ${maxFolderSteps} steps from a folder into the next`, maxFolderSteps);
      previous = names;
      paths.push(file);
      if (status === 'A') created.push(file);
      if (status === 'D') deleted.push(file);
      if (status === 'D' && oldMode === '120000') deletedLinks.push(file);
      // A gitlink names a commit that never travels: a repository the agent made inside its project.
      if (status !== 'D' && newMode === '160000') nested.push(file);
      // Both sides count. A patch reads what is there now, a deletion included, and writes what comes:
      // measured with git 2.50.1, deleting one 431 MB file cost `diff-tree` 1.09 GB and `apply` 1.67 GB,
      // while the deletion itself brings no object at all.
      if (oldMode !== '160000' && !/^0+$/.test(oldId)) touched.push(oldId);
      if (status !== 'D' && newMode !== '160000') touched.push(newId);
    }
    const sizes = await sizesOf(g, where, [...new Set(touched)]);
    const changedBytes = touched.reduce((sum, id) => sum + sizes.get(id).size, 0);
    if (changedBytes > maxChangedBytes) throw refuse.tooLarge(changedBytes, maxChangedBytes);
    return { changedPaths, changedBytes, nestedRepositories: reported(nested), paths, created, deleted, deletedLinks };
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
      if (error.code === 'command_output_too_large') throw refuse.tooMany(`brings so many objects that their list is longer than ${LIST_MAX_OUTPUT_BYTES} bytes`, LIST_MAX_OUTPUT_BYTES);
      throw error;
    }
    if (fresh.length > maxChangedEntries) throw refuse.tooMany(`brings more than ${maxChangedEntries} objects`, maxChangedEntries);
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
        tooMany: (what, limit) => new SpaceError('result_too_many_changes', `The work of the space ${what}, the limit of one result. Nothing reached the repository.`, { step: 'measure the result', limit }),
        tooLarge: (bytes, limit) => new SpaceError('result_too_large', `The work of the space brings ${bytes} bytes, more than the limit of ${limit}. Nothing reached the repository.`, { step: 'measure the result', limit, newBytes: bytes }),
      };
      // What the history brings is what the user's repository keeps, so it is what is capped here.
      // What a patch of it would cost, its bytes and its folders, is measured again by
      // `applyAsChanges`, where it is paid; here neither is refused, so the branch holds such work.
      const { newBytes } = await measureHistory(g, quarantine, start, result, limits, refuse);
      const { paths, created, deleted, deletedLinks, ...change } = await measureChange(g, quarantine, start, result, {
        ...limits, maxChangedBytes: Number.MAX_SAFE_INTEGER, maxFolders: Number.MAX_SAFE_INTEGER, maxFolderSteps: Number.MAX_SAFE_INTEGER,
      }, refuse);
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
      const clash = await branchInTheWay(g, top, name);
      if (clash !== null) {
        throw new SpaceError('branch_exists', `A branch named ${clash} already exists, and git cannot keep a branch named ${name} beside it. Choose another name; the existing branch was not changed.`, { branch: clash });
      }
      throw new SpaceError('git_command_failed', `Could not create the branch ${name}: ${tail(created.stderr) || `exit code ${created.code}`}`, { exitCode: created.code });
    }
    return { branch: name, commit: result };
  });

  /**
   * A branch that keeps `name` from being made, or null: git keeps a branch as a file under the name's
   * folders, so `feature/x` cannot be made beside a branch `feature`, nor `topic` beside `topic/one`.
   */
  const branchInTheWay = async (g, top, name) => {
    const folders = name.split('/').slice(0, -1);
    for (let depth = 1; depth <= folders.length; depth += 1) {
      const above = folders.slice(0, depth).join('/');
      if (await readRef(g, top, `refs/heads/${above}`)) return above;
    }
    const below = line(await g.output(top, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/heads/${name}/`]));
    return below === '' ? null : below.slice('refs/heads/'.length);
  };

  /** A boolean setting of this repository, false when it is not set. */
  const readSetting = async (g, top, key) => line((await g.run(top, ['config', '--bool', '--get', key])).stdout) === 'true';

  const exists = (full) => fs.lstat(full).then(() => true, () => false);

  /** Writes the patch from `from` to `to` into `file`, with git's plumbing and never the user's diff settings. */
  const writePatch = (g, top, from, to, file) => g.output(top, [...PATCH_ARGS, `--output=${file}`, from, to], { timeoutMs: APPLY_TIMEOUT_MS });

  /**
   * Whether `patch` applies to the working tree as it is now, or backwards with `reverse`: the dry run
   * and nothing else. Only the end of what it prints is kept, so its answer never depends on how much
   * it has to say. It reads the files through the user's clean filters, which run as children of git, so
   * a timeout ends its whole tree.
   */
  const dryRun = (g, top, patch, { reverse = false } = {}) => g.run(top, [...APPLY_ARGS, '--check', ...(reverse ? ['--reverse'] : []), patch], {
    timeoutMs: APPLY_TIMEOUT_MS, maxOutputBytes: APPLY_OUTPUT_TAIL_BYTES, keepTail: true, killTree: true,
  });

  /**
   * One call of `applyAsChanges` or `describeApplyState`: where it works, what it already asked git,
   * and until when it may read the working tree back. A pair of trees is listed once per call, and a
   * patch built and dry-run once, because nothing of the working tree changes before the real apply:
   * sorting out an interrupted apply and the apply after it usually ask about the same pair. For the
   * same reason each path of the working tree is read once per call, `readings`, and the folders on the
   * way to it looked at once, `folders`.
   */
  const startCall = (g, directory, top) => ({
    g, directory, top, until: Date.now() + readBackTimeoutMs, listings: new Map(), patches: new Map(), files: 0,
    settings: null, readings: new Map(), folders: new Map(), commits: new Map(),
  });

  /**
   * What a read-back that did not end in time throws: nothing is known then, and nothing is guessed.
   * With `failed`, why reading back failed outright, which is answered the same way: what git said,
   * for a clean filter of the user's that fails on a file, which would otherwise fail every later
   * call, or the sentence `hashFile` could not read a file with.
   */
  const undecided = (failed = null) => new SpaceError(
    'changes_undecided',
    failed === null
      ? `Reading your project back took longer than ${Math.round(readBackTimeoutMs / 1000)} seconds, so it is not known how much of what was last applied from this space is still there.`
      : `Reading your project back failed, so it is not known how much of what was last applied from this space is still there. ${failed}`,
    failed === null ? { limitMs: readBackTimeoutMs } : { limitMs: readBackTimeoutMs, cause: 'read_back_failed' },
  );

  /**
   * Host git for reading the working tree back, within the time of the call: each command gets what is
   * left of it, and one that runs out of it, or prints more than the host reads, is `changes_undecided`.
   * Without the bound, a tree that is slow to read failed every later call the same way: measured by a
   * reviewer, past about 6 ms a file at a hundred thousand files the comparison hit the apply's deadline.
   * Each ends with its whole tree, `killTree`: git starts the user's filters as children of its own, and
   * a reviewer found one orphaned per call when only git was killed, a filter that hangs left for good.
   */
  const readingBack = (call) => {
    const bounded = (method) => async (where, args, options = {}) => {
      const left = call.until - Date.now();
      if (left <= 0) throw undecided();
      try {
        return await call.g[method](where, args, { ...options, killTree: true, timeoutMs: Math.min(options.timeoutMs ?? APPLY_TIMEOUT_MS, left) });
      } catch (error) {
        if (error.code === 'command_timeout' || error.code === 'command_output_too_large') throw undecided();
        throw error;
      }
    };
    return { run: bounded('run'), output: bounded('output') };
  };

  /** The listing of what `to` changes against `from`, asked once per call. */
  const listed = async (call, g, from, to) => {
    const key = `${from} ${to}`;
    if (!call.listings.has(key)) call.listings.set(key, await listChange(g, call.top, from, to));
    return call.listings.get(key);
  };

  /** The patch from `from` to `to` in the call's folder, built once per call, `{ file, check }`. */
  const patchOf = async (call, g, from, to) => {
    const key = `${from} ${to}`;
    if (!call.patches.has(key)) {
      call.files += 1;
      const file = path.join(call.directory, `change-${call.files}.patch`).replaceAll('\\', '/');
      await writePatch(g, call.top, from, to, file);
      call.patches.set(key, { file, check: null });
    }
    return call.patches.get(key);
  };

  /** The dry run of the patch from `from` to `to`, run once per call. */
  const checkOf = async (call, g, from, to) => {
    const patch = await patchOf(call, g, from, to);
    patch.check ??= await dryRun(g, call.top, patch.file);
    return patch.check;
  };

  const ABSENT = '000000';
  const GITLINK = '160000';
  const LINK = '120000';
  const EXECUTABLE = '100755';
  const isRegular = (side) => side.mode === '100644' || side.mode === EXECUTABLE;

  /** A boolean setting of this repository, or `fallback` when it is not set. */
  const readFlag = async (g, top, key, fallback) => {
    const found = await g.run(top, ['config', '--bool', '--get', key]);
    return found.code === 0 ? line(found.stdout) === 'true' : fallback;
  };

  /**
   * What reading this working tree back depends on, asked once per call: the hash the repository names
   * objects with, and whether git here sees the exec bit (`core.filemode`) and keeps links as links
   * (`core.symlinks`), both true unless the repository says otherwise, as git itself takes them.
   */
  const settingsOf = async (call) => {
    call.settings ??= {
      algorithm: line(await call.g.output(call.top, ['rev-parse', '--show-object-format'])),
      filemode: await readFlag(call.g, call.top, 'core.filemode', true),
      symlinks: await readFlag(call.g, call.top, 'core.symlinks', true),
    };
    return call.settings;
  };

  /**
   * The paths of the change from `from` to `to` that a working tree can hold apart, each with both
   * sides, `{ path, from: { mode, id }, to: { mode, id } }`. A gitlink never travels, so a path with one
   * on either side has nothing to compare and is left out, and so is a change of the exec bit alone
   * where git here does not see the exec bit: the two sides are the same file on this disk.
   */
  const comparedPaths = async (call, g, from, to) => {
    const { filemode } = await settingsOf(call);
    const fields = await listed(call, g, from, to);
    const entries = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [oldMode, newMode, oldId, newId] = fields[index].slice(1).split(' ');
      if (oldMode === GITLINK || newMode === GITLINK) continue;
      if (!filemode && oldId === newId && oldMode !== LINK && newMode !== LINK) continue;
      entries.push({ path: fields[index + 1], from: { mode: oldMode, id: oldId }, to: { mode: newMode, id: newId } });
    }
    return entries;
  };

  /**
   * Whether every folder on the way to `file` is a plain folder of the work tree, each looked at once
   * per call. Below anything else, a link to another place included, `git status` reads the path as
   * absent, and so does this: nothing is read through a link.
   */
  const plainWay = async (call, file) => {
    let relative = '';
    for (const name of file.split('/').slice(0, -1)) {
      relative = relative === '' ? name : `${relative}/${name}`;
      if (!call.folders.has(relative)) {
        call.folders.set(relative, await files.lstat(path.join(call.top, ...relative.split('/'))).then((stats) => stats.isDirectory(), () => false));
      }
      if (!call.folders.get(relative)) return false;
    }
    return true;
  };

  /**
   * What the working tree holds at `file`, read by the host itself, with no git and no filter:
   * `{ kind, executable, raw, clean }`. `kind` is `absent`, `file`, `link` or `other`; `raw` the id the
   * bytes there would have as a blob, a link's target for a link; `clean` is left for `cleanIds`. A file
   * is read a piece at a time and never held whole, and nothing is written anywhere.
   */
  const lookAt = async (call, file) => {
    if (call.readings.has(file)) return call.readings.get(file);
    const { algorithm } = await settingsOf(call);
    const full = path.join(call.top, ...file.split('/'));
    let reading = { kind: 'absent' };
    if (await plainWay(call, file)) {
      const stats = await files.lstat(full).catch(() => null);
      if (stats?.isSymbolicLink()) {
        const target = await files.readlink(full, { encoding: 'buffer' }).catch(() => null);
        reading = target === null ? { kind: 'other' } : { kind: 'link', raw: blobId(algorithm, target) };
      } else if (stats?.isFile()) {
        let raw = CHANGED_WHILE_READ;
        try {
          // A file that changed while it was read, as when the user's editor saves it at that moment, is
          // read again, a few times, before nothing is known of it.
          for (let read = 0; raw === CHANGED_WHILE_READ && read < READS_OF_A_CHANGING_FILE; read += 1) {
            if (read > 0) await pause(PAUSE_BETWEEN_READS_MS);
            raw = await hashFile(files, full, algorithm, call.until);
          }
        } catch (error) {
          if (error.code === 'command_timeout') throw undecided();
          throw error;
        }
        // Something else than the plain file `lstat` saw, or a read that failed: never handed to git
        // instead, which would follow a link or wait on a FIFO. Nothing is known then.
        if (raw === null) throw undecided(`${reported([file]).paths[0]} could not be read as a plain file.`);
        if (raw === CHANGED_WHILE_READ) throw undecided(`${reported([file]).paths[0]} kept changing while it was read.`);
        reading = { kind: 'file', executable: (stats.mode & 0o100) !== 0, raw, clean: undefined };
      } else if (stats) {
        reading = { kind: 'other' };
      }
    }
    call.readings.set(file, reading);
    return reading;
  };

  /**
   * Fills in `clean` for each of `paths` that is a file: its id as git reads it back through the user's
   * clean filters and line endings, the way `git status` compares, from one `hash-object --stdin-paths`
   * that streams the answers. The attributes are exactly the ones of the working tree as it is now, with
   * the user's global and `info/attributes` files: git would fall back to the index for a folder whose
   * `.gitattributes` is missing, so it is given an index that does not exist. Nothing is written. A name
   * that the line-by-line input cannot carry, one with a line break or starting with a quote, is asked
   * on its own.
   */
  const cleanIds = async (call, g, paths) => {
    const env = { GIT_INDEX_FILE: path.join(call.directory, 'no-index') };
    const { algorithm } = await settingsOf(call);
    const idLength = algorithm === 'sha256' ? 64 : 40;
    const asked = paths.filter((file) => call.readings.get(file)?.kind === 'file' && call.readings.get(file).clean === undefined);
    const odd = (file) => /[\n\r]/.test(file) || file.startsWith('"');
    const together = asked.filter((file) => !odd(file));
    const answer = async (args, stdin, count) => {
      // A chatty filter prints to stderr for every file: only the end of that is kept, never failing.
      const done = await g.run(call.top, args, { env, stdin, maxOutputBytes: count * (idLength + 1) + APPLY_OUTPUT_TAIL_BYTES, keepTail: true });
      const ids = done.stdout.split('\n').filter(Boolean);
      if (done.code !== 0 || ids.length !== count) throw undecided(`Git said: ${tail(done.stderr) || `exit code ${done.code}`}`);
      return ids;
    };
    if (together.length > 0) {
      const ids = await answer(['hash-object', '--stdin-paths'], together.map((file) => `${file}\n`).join(''), together.length);
      together.forEach((file, index) => { call.readings.get(file).clean = ids[index]; });
    }
    for (const file of asked.filter(odd)) {
      [call.readings.get(file).clean] = await answer(['hash-object', '--', file], '', 1);
    }
  };

  /** Whether `reading`'s kind and exec bit fit `side`, as git here compares them. */
  const fits = (call, reading, side) => {
    if (side.mode === ABSENT) return reading.kind === 'absent';
    if (side.mode === LINK) return reading.kind === 'link' || (!call.settings.symlinks && reading.kind === 'file');
    return reading.kind === 'file' && (!call.settings.filemode || reading.executable === (side.mode === EXECUTABLE));
  };
  const holdsRaw = (call, reading, side) => fits(call, reading, side) && (side.mode === ABSENT || reading.raw === side.id);
  const holdsClean = (call, reading, side) => isRegular(side) && fits(call, reading, side) && reading.clean === side.id;

  /** `lookAt` for the path of each of `entries`, a few at once; the first failure stops the rest from starting. */
  const lookAtAll = async (call, entries) => {
    let failed = null;
    let next = 0;
    const worker = async () => {
      while (failed === null && next < entries.length) {
        const entry = entries[next];
        next += 1;
        try {
          await lookAt(call, entry.path);
        } catch (error) {
          failed ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, entries.length) }, worker));
    if (failed !== null) throw failed;
  };

  /**
   * Which side of its change the working tree holds at each of `entries`: `to`, `from` or `neither`.
   * The bytes decide first: a file that is byte for byte one side's blob holds that side, `to` before
   * `from`, which is what `git apply` wrote or `git restore` put back where no filter changes a byte, and
   * costs no git at all. Only a file that is neither side's bytes is read the way `git status` reads it,
   * through the user's clean filters and line endings, see `cleanIds`: a file an LFS-like filter keeps,
   * or one the user's line endings changed. Nothing is written, and no smudge filter runs. Each look at
   * a file checks the time the call has left.
   */
  const sidesHeld = async (call, g, entries) => {
    await lookAtAll(call, entries);
    const reading = (entry) => call.readings.get(entry.path);
    await cleanIds(call, g, entries
      .filter((entry) => (isRegular(entry.to) || isRegular(entry.from)) && !holdsRaw(call, reading(entry), entry.to) && !holdsRaw(call, reading(entry), entry.from))
      .map((entry) => entry.path));
    return entries.map((entry) => {
      if (holdsRaw(call, reading(entry), entry.to)) return 'to';
      if (holdsRaw(call, reading(entry), entry.from)) return 'from';
      if (holdsClean(call, reading(entry), entry.to)) return 'to';
      if (holdsClean(call, reading(entry), entry.from)) return 'from';
      return 'neither';
    });
  };

  /**
   * Which of `paths` a commit of the user's changed since the last apply: a commit reachable from
   * `head`, this working tree's HEAD, and not from `since`, the HEAD the last apply recorded, each a
   * commit or null for none yet. A move back, a reset to before or a checkout of an older commit, adds
   * no such commit, so the paths it put back count as thrown away; a revert is a new commit and counts
   * as the user's change. Another linked worktree or another branch compares the same way: only commits
   * the last apply's HEAD does not have count.
   *
   * One `git log --name-only` over that range and every path, once per call and range, `call.commits`:
   * each question of the call, the look at every apply and the look at the last one, is answered from
   * that one list. Limited to the paths asked, as the eighth round did, git compared each commit against
   * each of them: measured, 74 s for a hundred thousand paths over ten thousand commits, and past the
   * five minutes for commits that touched them, against 2.9 s and 0.3 s for the whole list. It is bounded
   * by the call's time and the 64 MiB listing cap, past which the call is `changes_undecided`, and it
   * prints as it walks, so a host that dies stops it at its next write. No history is simplified: a
   * commit on a side branch that a merge brought counts even where the merge dropped its change, which
   * takes that path for the user's edit, never for a throw-away. Merges list nothing of their own.
   */
  const committedAmong = async (call, g, since, head, paths) => {
    if (since === head || head === null || paths.length === 0) return new Set();
    const range = since === null ? [head] : [head, `^${since}`];
    const key = range.join(' ');
    if (!call.commits.has(key)) {
      const names = await g.output(call.top, ['--literal-pathspecs', 'log', '--format=', '--name-only', '-z', '--no-renames', '--no-show-signature', ...range, '--'], {
        maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
      });
      // git 2.54 separates nothing but the names; a git that put a line break before a commit's names
      // would glue it to the first. Both spellings count, so a name that begins with a line break is
      // found as it is, and an extra spelling can only take a path for the user's edit.
      const changed = new Set();
      for (const name of names.split('\0')) {
        if (name !== '') changed.add(name).add(name.replace(/^\n+/, ''));
      }
      call.commits.set(key, changed);
    }
    const changed = call.commits.get(key);
    return new Set(paths.filter((file) => changed.has(file)));
  };

  // How many paths each look takes where the first path found answers the question: one, then sixteen
  // times more each time. A work tree that still holds the change answers at its first path.
  const LOOK_GROWTH = 16;
  const inLooks = (list) => {
    const looks = [];
    for (let at = 0, size = 1; at < list.length; at += size, size *= LOOK_GROWTH) looks.push(list.slice(at, at + size));
    return looks;
  };

  /**
   * What the user did to each path of the change from `before` to `applied`, the maintainer's rule of
   * 2026-09-25 made exact in round eight, per path:
   * - the working tree holds the applied side: `kept`;
   * - it holds neither side: `edited`, the user's own edit;
   * - it holds the side before, and a commit of the user's since the last apply changed that path, one
   *   reachable from this worktree's HEAD and not from `applied-head`: `edited` as well, the user's
   *   committed change, a revert among them, see `committedAmong`;
   * - it holds the side before, and no commit since touched it: `thrown`.
   * With `untilTrace` it stops at the first path that is not thrown, a few paths first and more each
   * time, and `trace` says whether there was one. `trace` is true as well when no path could be told
   * apart at all: that is no evidence that anything was thrown away.
   */
  const whatBecameOf = async (call, g, before, applied, { appliedHead, head, untilTrace = false }) => {
    const entries = await comparedPaths(call, g, before, applied);
    const kept = [];
    const edited = [];
    const thrown = [];
    for (const look of untilTrace ? inLooks(entries) : [entries]) {
      const held = await sidesHeld(call, g, look);
      const committed = await committedAmong(call, g, appliedHead, head, look.filter((_, index) => held[index] === 'from').map((entry) => entry.path));
      look.forEach((entry, index) => {
        if (held[index] === 'to') kept.push(entry.path);
        else if (held[index] === 'neither' || committed.has(entry.path)) edited.push(entry.path);
        else thrown.push(entry.path);
      });
      if (untilTrace && kept.length + edited.length > 0) break;
    }
    return { kept, edited, thrown, trace: kept.length + edited.length > 0 || thrown.length === 0 };
  };

  /**
   * What an interrupted apply left in the working tree, for the paths of the patch from `from` to `to`:
   * `finished`, `not_started` or `partly`. First each path is read, see `sidesHeld`: every path as in
   * `to` is `finished`, every path as in `from` is `not_started`. The user may have edited something
   * since, which leaves a path as neither, so the dry run an apply makes decides then: when no path holds
   * `to` and the patch still applies, nothing was written; when no path holds `from` and the patch
   * applies backwards, all of it was. `git apply` writes a whole file at a time, so a path it wrote holds
   * `to`, and the first condition keeps a hunk that would apply a second time, as a line added among
   * repeated lines can, from being taken for one never written. Anything else is `partly`. Nothing of the
   * user's is written.
   */
  const interruptedApplyState = async (call, g, from, to) => {
    const held = await sidesHeld(call, g, await comparedPaths(call, g, from, to));
    if (held.every((side) => side === 'to')) return 'finished';
    if (held.every((side) => side === 'from')) return 'not_started';
    if (!held.includes('to') && (await checkOf(call, g, from, to)).code === 0) return 'not_started';
    if (!held.includes('from') && (await dryRun(g, call.top, (await patchOf(call, g, from, to)).file, { reverse: true })).code === 0) return 'finished';
    return 'partly';
  };

  /**
   * What an interrupted apply to `applying` left, read against `base`, what its patch was built from,
   * and, when that reads as `partly`, against each of `others` in turn, where the applies before it
   * came from: the user may have thrown an earlier apply away after the host went away, and a reviewer
   * had an attempt that wrote nothing taken for a part and the route closed. Resolves `{ state, base }`,
   * `base` being what the working tree matched.
   */
  const readInterrupted = async (call, g, applying, base, others) => {
    const state = await interruptedApplyState(call, g, base, applying);
    if (state !== 'partly') return { state, base };
    for (const other of new Set(others.filter((candidate) => candidate !== null && candidate !== base))) {
      const again = await interruptedApplyState(call, g, other, applying);
      if (again !== 'partly') return { state: again, base: other };
    }
    return { state, base };
  };

  /**
   * Where the next apply builds its patch from, the maintainer's decision of 2026-09-25 made exact:
   * "thrown away" is decided path by path from what is authoritative, the refs of the last apply, the
   * user's HEAD and the working tree, see `whatBecameOf`, and a part thrown away is never passed over in
   * silence. An edit of the user's, committed or not, is never a throw-away.
   * - No apply yet: from the start. A last apply recorded before `applied-from` existed: from it.
   * - Every path of every apply so far thrown away: the whole work from the start.
   * - Every path of the last apply thrown away: from where that apply started, even where the patch
   *   from it would fit.
   * - Some thrown away and some kept or edited: `{ partly: { gone, stillThere } }`, which the apply
   *   refuses, because any patch would leave what the user threw away out without a word.
   * - Nothing thrown away: from the last apply.
   * Resolves `{ from }` or `{ partly }`. `g` reads the working tree back within the call's time.
   */
  const decideBase = async (call, g, { start, applied, appliedFrom, appliedHead, head }) => {
    if (applied === null) return { from: start };
    if (appliedFrom === null) return { from: applied };
    if (appliedFrom !== start && !(await whatBecameOf(call, g, start, applied, { appliedHead, head, untilTrace: true })).trace) return { from: start };
    const last = await whatBecameOf(call, g, appliedFrom, applied, { appliedHead, head });
    const stillThere = [...last.kept, ...last.edited];
    if (last.thrown.length > 0 && stillThere.length > 0) return { partly: { gone: last.thrown, stillThere } };
    if (last.thrown.length > 0) return { from: appliedFrom };
    return { from: applied };
  };

  /**
   * The files among the paths of the patch from `from` to the result that a filter such as Git LFS
   * keeps in the user's project, and that the patch cannot fit for that reason alone: the working file
   * is byte for byte the blob `from` has, which is what that filter's smudge left there for a file the
   * agent changed, while git reads it back through the filter as something else, so `git apply` finds
   * another file than the patch expects. Asked only after a dry run failed, to say so in the refusal,
   * and cheaply: the bytes first, then the filter attribute, and the filter itself only for the files
   * whose bytes are the blob and whose attributes name a configured filter.
   */
  const filteredInTheWay = async (call, g, from, result) => {
    const entries = (await comparedPaths(call, g, from, result)).filter((entry) => isRegular(entry.from));
    await lookAtAll(call, entries);
    const bytesAsBefore = entries.filter((entry) => holdsRaw(call, call.readings.get(entry.path), entry.from));
    if (bytesAsBefore.length === 0) return [];
    const env = { GIT_INDEX_FILE: path.join(call.directory, 'no-index') };
    const drivers = new Set((await g.run(call.top, ['config', '-z', '--get-regexp', '^filter\\..*\\.(clean|process)$'])).stdout.split('\0').filter(Boolean)
      .map((entry) => entry.slice(0, entry.indexOf('\n')).replace(/^filter\./, '').replace(/\.(?:clean|process)$/, '')));
    const fields = (await g.output(call.top, ['check-attr', '-z', '--stdin', 'filter'], { env, stdin: bytesAsBefore.map((entry) => `${entry.path}\0`).join('') })).split('\0');
    const covered = new Set();
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (drivers.has(fields[index + 2])) covered.add(fields[index]);
    }
    const asked = bytesAsBefore.filter((entry) => covered.has(entry.path));
    await cleanIds(call, g, asked.map((entry) => entry.path));
    return asked.filter((entry) => call.readings.get(entry.path).clean !== entry.from.id).map((entry) => entry.path);
  };

  /**
   * Whether any of `paths`, already read back in this call, holds something else than `head` has
   * there, as `git status` compares: those are what a merge of the branch, or a switch to it, would
   * refuse to overwrite. A file the user committed as it is, or a deletion they committed, is not.
   * Asked only to word the refusal of a part thrown away, so a failure is the caller's to answer.
   */
  const differFromHead = async (call, g, head, paths) => {
    const sides = new Map();
    if (head !== null) {
      const tree = await g.output(call.top, ['ls-tree', '-r', '-z', '--full-tree', head], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES });
      for (const entry of tree.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab === -1) continue;
        const [mode, , id] = entry.slice(0, tab).split(' ');
        sides.set(entry.slice(tab + 1), { mode, id });
      }
    }
    const entries = paths.map((file) => ({ path: file, head: sides.get(file) ?? { mode: ABSENT, id: '' } }));
    const reading = (entry) => call.readings.get(entry.path);
    await cleanIds(call, g, entries.filter((entry) => isRegular(entry.head) && !holdsRaw(call, reading(entry), entry.head)).map((entry) => entry.path));
    return entries.some((entry) => !holdsRaw(call, reading(entry), entry.head) && !holdsClean(call, reading(entry), entry.head));
  };

  /**
   * Where this space stands for an apply as uncommitted changes, read and nothing else: whether that
   * route is `open` or `closed`, the result the last apply wrote (`lastApplied`, or null), the result
   * that is there now (`result`, or null before any bring-out), how many paths an apply would write
   * now (`newPaths`), and whether an earlier apply was interrupted (`interruptedApply`), which the
   * next apply sorts out before anything else. `newPaths` counts from where the next apply builds its
   * patch, decided by `readInterrupted` and `decideBase` as the apply decides it: from what the last
   * apply wrote, from what an interrupted apply wrote when the working tree shows it finished, from
   * before the last apply or from the start when the user threw applies away, and from the last apply
   * when the user threw away part of it, which the apply then refuses.
   * `newPaths` is null without a result, and also when its list is longer than the host reads,
   * `newPathsOverLimit`: an apply of that many is refused as too large, and the branch is the way. It
   * is null as well when reading the working tree back did not end in time, `newPathsUndecided`, which
   * the apply answers with `changes_undecided`. An intent beside a closed route is not reported:
   * nothing applies as changes there any more. Waits for an apply of the same space in this process to
   * end, so it never reports an apply under way as interrupted.
   */
  const describeApplyState = (request) => withHostGit('code_out_failed', async (g, directory) => {
    const { repository, spaceId } = request ?? {};
    requireSpaceId(spaceId);
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    return inTurn(await applyTurnKey(g, top, spaceId), async () => {
      const call = startCall(g, directory, top);
      const back = readingBack(call);
      const start = await requireStart(g, top, spaceId);
      const result = await readRef(g, top, resultRef(spaceId));
      const lastApplied = await readRef(g, top, appliedRef(spaceId));
      const closed = await readRef(g, top, closedRef(spaceId));
      const applying = closed ? null : await readRef(g, top, applyingRef(spaceId));
      // The last apply, where it came from and HEAD then, as the next apply will see them once it has
      // sorted out an interrupted one.
      let applied = lastApplied;
      let appliedFrom = applied ? await readRef(g, top, appliedFromRef(spaceId)) : null;
      let appliedHead = applied ? await readRef(g, top, appliedHeadRef(spaceId)) : null;
      let from = applied ?? start;
      let undecidedHere = false;
      if (result) {
        try {
          let interrupted = null;
          if (applying) {
            const recordedBase = await readRef(g, top, applyingFromRef(spaceId));
            const read = await readInterrupted(call, back, applying, recordedBase ?? lastApplied ?? start, [appliedFrom, start]);
            interrupted = read.state;
            if (interrupted === 'finished') {
              applied = applying;
              appliedFrom = read.base;
              appliedHead = await readRef(g, top, applyingHeadRef(spaceId));
            }
          }
          from = applied ?? start;
          // Where the apply would close the route first, it never gets to choose a base, so neither does this.
          if (!closed && interrupted !== 'partly') {
            const decision = await decideBase(call, back, { start, applied, appliedFrom, appliedHead, head: await readRef(g, top, 'HEAD') });
            from = decision.from ?? applied;
          }
        } catch (error) {
          if (error.code !== 'changes_undecided') throw error;
          undecidedHere = true;
        }
      }
      let newPaths = null;
      if (result && !undecidedHere) {
        try {
          const names = await g.output(top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, result], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS });
          newPaths = names.split('\0').filter(Boolean).length;
        } catch (error) {
          if (error.code !== 'command_output_too_large') throw error;
        }
      }
      return {
        changesRoute: closed ? 'closed' : 'open',
        result,
        lastApplied,
        newPaths,
        newPathsOverLimit: result !== null && newPaths === null && !undecidedHere,
        newPathsUndecided: undecidedHere,
        interruptedApply: applying !== null,
      };
    });
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
   * When the user threw applies away, the whole work comes again instead, from before them, and a part
   * thrown away is refused: see `decideBase`. Each apply records what its patch was built from,
   * `applied-from`, and the user's HEAD at the time, `applied-head`, beside `applied`.
   *
   * A dry run that fails is `changes_do_not_apply` and nothing was touched. A real apply that fails
   * after a clean dry run, for a folder that cannot be written or a disk that is full, is
   * `changes_partly_applied`: part of the work may be in the working tree, and the remembered ref is
   * not moved, because it no longer describes what is there. Reading the working tree back, or the dry
   * run, that does not end in time is `changes_undecided`.
   *
   * Each of those closes this route for the space, as `refs/openchamber/spaces/<id>/changes-closed`:
   * the user's project and the agent's work have gone apart, or cannot be compared, and every later call
   * refuses at once with `changes_route_closed`, before any patch is built. `applyAsBranch` keeps
   * working and closes nothing. Nothing in this stage opens the route again.
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
    return inTurn(await applyTurnKey(g, top, spaceId), () => applyInTurn(startCall(g, directory, top), spaceId, { maxChangedBytes, maxChangedEntries }));
  });

  /**
   * The patch from `from` to the result, with every check an apply makes before it writes anything,
   * and nothing of the user's written: the caps, the names, the folder walk, the patch in the call's
   * folder, and the dry run. Throws the refusals that leave the route open, `changes_too_large`,
   * `name_not_allowed_here`, `case_only_rename` and `patch_not_possible`. Resolves `{ outcome:
   * 'nothing' }` when the two are the same, `{ outcome: 'blocked', folder }` for a folder on the way
   * that leads somewhere else, `{ outcome: 'slow' }` for a dry run that did not end in time, and
   * otherwise `{ outcome: 'checked', change, patch, check }`, `check` being the dry run. What closes the
   * route is the caller's to write.
   */
  const preparePatch = async (call, from, result, { maxChangedBytes, maxChangedEntries }) => {
    const { g, top } = call;
    // What this patch would read and write, measured here because this is where it is paid, and for
    // a pair `bringCodeOut` never saw: the result against the last apply.
    // The folders count against a cap of the same size as the paths: a folder costs an apply about what
    // a path costs in memory, one node of the name check, one entry of the link check. A cap of its own
    // and not a share of the paths' cap, so a large ordinary change, twenty thousand files in sixty
    // thousand folders of their own, still applies; together at most twice what the paths' cap alone
    // allowed. The steps get FOLDER_STEPS_PER_ENTRY times that, see there.
    const tooLarge = (what, limit) => new SpaceError(
      'changes_too_large',
      `The work of the space is too large to apply as uncommitted changes: it ${what}. Nothing was changed. Apply it as a branch instead.`,
      { limit },
    );
    const refuse = {
      tooMany: (what, limit) => tooLarge(what, limit),
      tooLarge: (bytes, limit) => tooLarge(`would read and write ${bytes} bytes, more than the limit of ${limit}`, limit),
    };
    const change = await measureChange(g, top, from, result, {
      maxChangedBytes, maxChangedEntries, maxFolders: maxChangedEntries, maxFolderSteps: maxChangedEntries * FOLDER_STEPS_PER_ENTRY,
    }, refuse, () => listed(call, g, from, result));
    if (change.changedPaths === 0) return { outcome: 'nothing' };
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
        const why = {
          differs_only_in_case: `differs from ${other} only in case, and this computer takes the two for one file`,
          path_too_long: 'is a path too long for this computer, in your project\'s folder',
        }[unholdable.rule] ?? 'has a name this computer cannot hold';
        throw new SpaceError(
          'name_not_allowed_here',
          `The agent made ${shown}, which ${why}, so nothing was changed. Have the agent rename it, then bring the work out again.`,
          details,
        );
      }
    }
    // Checked here and not left to git, before anything is built or written.
    const redirected = await firstRedirectedFolder(top, change.paths, { ...names, deletedLinks: change.deletedLinks });
    if (redirected !== null) return { outcome: 'blocked', folder: redirected };
    let patch;
    try {
      patch = await patchOf(call, g, from, result);
    } catch (error) {
      // git refuses to build a diff it cannot hold, for one huge file among others.
      throw new SpaceError(
        'patch_not_possible',
        `A patch of the work of the space could not be built, so nothing was changed. Apply it as a branch instead. Git said: ${error.message}`,
        { cause: error.code ?? null },
      );
    }
    try {
      return { outcome: 'checked', change, patch: patch.file, check: await checkOf(call, g, from, result) };
    } catch (error) {
      // The dry run reads every file the patch touches, through the user's filters, which can be slow
      // enough never to end in time; every later call would then fail the same way.
      if (error.code === 'command_timeout') return { outcome: 'slow' };
      throw error;
    }
  };

  /** Up to three of the paths `shown`, `{ count, paths }`, as words: "a, b and 4 more". */
  const someOf = ({ count, paths }) => {
    const named = paths.slice(0, 3);
    if (count > named.length) return `${named.join(', ')} and ${count - named.length} more`;
    return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  };

  /** The body of `applyAsChanges`, run while no other apply of this space in this process runs. */
  const applyInTurn = async (call, spaceId, caps) => {
    const { g, top } = call;
    const start = await requireStart(g, top, spaceId);
    const result = await requireResult(g, top, spaceId);
    if (await readRef(g, top, closedRef(spaceId))) {
      throw new SpaceError(
        'changes_route_closed',
        `The work of this space is no longer applied as uncommitted changes: it and your project went apart. ${BRANCH_FROM_NOW_ON}`,
      );
    }
    // Written before a refusal below leaves, so a later call refuses at once.
    const closing = `openchamber: the work of space ${spaceId} is applied as a branch now`;
    const close = () => g.run(top, ['update-ref', '-m', closing, closedRef(spaceId), result]);
    // An intent is up to three refs, `applying` at `at`, `applying-from` at `base` and `applying-head`
    // at `head`, the last two absent in an intent written before they existed, or with no commit at
    // HEAD. Where one was written, the route closes and the intent goes in one transaction: a host that
    // dies in between leaves both or neither, never a closed route beside an intent. When the
    // transaction fails, neither was written, and the next call finds the intent and sorts it out.
    const forgetIntent = (at, base, head) => [
      `delete ${applyingRef(spaceId)} ${at}\n`,
      base ? `delete ${applyingFromRef(spaceId)} ${base}\n` : '',
      head ? `delete ${applyingHeadRef(spaceId)} ${head}\n` : '',
    ].join('');
    const closeAndForget = async (at, base, head) => (await g.run(top, ['update-ref', '-m', closing, '--stdin'], {
      stdin: `update ${closedRef(spaceId)} ${at}\n${forgetIntent(at, base, head)}`,
    })).code === 0;
    // Where the last apply leaves the user's HEAD, moving with `applied`.
    const headRecord = (head) => (head ? `update ${appliedHeadRef(spaceId)} ${head}\n` : `delete ${appliedHeadRef(spaceId)}\n`);
    // What the last apply of this space put there, or null when there was none, what its patch was
    // built from, or null in a repository from before that was recorded, and the user's HEAD then.
    let applied = await readRef(g, top, appliedRef(spaceId));
    let appliedFrom = applied ? await readRef(g, top, appliedFromRef(spaceId)) : null;
    let appliedHead = applied ? await readRef(g, top, appliedHeadRef(spaceId)) : null;
    const head = await readRef(g, top, 'HEAD');
    const back = readingBack(call);
    // An earlier apply was interrupted: the host went away between writing the files and the record.
    let intent = null;
    const applying = await readRef(g, top, applyingRef(spaceId));
    if (applying) intent = { at: applying, base: await readRef(g, top, applyingFromRef(spaceId)), head: await readRef(g, top, applyingHeadRef(spaceId)) };
    let decision;
    try {
      if (intent) {
        // An intent from before `applying-from` was built from the last apply, which has not moved since.
        const { state, base } = await readInterrupted(call, back, intent.at, intent.base ?? applied ?? start, [appliedFrom, start]);
        if (state === 'partly') {
          const recorded = await closeAndForget(intent.at, intent.base, intent.head);
          throw new SpaceError(
            'changes_partly_applied',
            `An earlier apply of the work of this space was interrupted, and part of it is in your project: look at what changed. Your project is now in a state this cannot reason about. ${BRANCH_FROM_NOW_ON}`,
            { interrupted: true, recorded },
          );
        }
        const record = state === 'finished'
          ? `update ${appliedRef(spaceId)} ${intent.at}\nupdate ${appliedFromRef(spaceId)} ${base}\n${headRecord(intent.head)}${forgetIntent(intent.at, intent.base, intent.head)}`
          : forgetIntent(intent.at, intent.base, intent.head);
        await g.output(top, ['update-ref', '-m', `openchamber: sorted out an interrupted apply of space ${spaceId}`, '--stdin'], { stdin: record });
        if (state === 'finished') {
          applied = intent.at;
          appliedFrom = base;
          appliedHead = intent.head;
        }
        intent = null;
      }
      decision = await decideBase(call, back, { start, applied, appliedFrom, appliedHead, head });
    } catch (error) {
      if (error.code !== 'changes_undecided') throw error;
      const recorded = intent ? await closeAndForget(intent.at, intent.base, intent.head) : (await close()).code === 0;
      throw new SpaceError('changes_undecided', `${error.message} So nothing was changed. ${BRANCH_FROM_NOW_ON}`, { ...error.details, recorded });
    }
    if (decision.partly) {
      await close();
      const gone = reported(decision.partly.gone);
      const kept = reported(decision.partly.stillThere);
      // "Changed since", not "by you": a pull of a colleague's change into one of those files lands here
      // too. The advice to clear the way for the branch only where git would refuse it: a file the user
      // committed as it is does not stand in the way. Asked after the route is closed; when it cannot be
      // told, the advice stays.
      const inTheWay = await differFromHead(call, back, head, decision.partly.stillThere).catch(() => true);
      throw new SpaceError(
        'changes_do_not_apply',
        `You threw away part of what was last applied from this space: ${someOf(gone)} ${gone.count === 1 ? 'is' : 'are'} back as before, while ${someOf(kept)} ${kept.count === 1 ? 'is' : 'are'} still there or changed since. An apply now would leave out what you threw away without a word, so nothing was changed. ${BRANCH_FROM_NOW_ON}${inTheWay ? ' Before you merge that branch or switch to it, remove or commit the files of this space that are still in your project, or git will refuse.' : ''}`,
        { thrownAway: gone, stillThere: kept },
      );
    }
    const { from } = decision;
    const prepared = await preparePatch(call, from, result, caps);
    if (prepared.outcome === 'nothing') return { status: 'nothing_to_apply' };
    if (prepared.outcome === 'blocked') {
      await close();
      const shown = reported([prepared.folder]).paths[0];
      throw new SpaceError(
        'changes_blocked_by_link',
        `The work of the space writes into ${shown}, which in your project is a link to another place, so nothing was changed. ${BRANCH_FROM_NOW_ON}`,
        { path: shown },
      );
    }
    if (prepared.outcome === 'slow') {
      await close();
      throw new SpaceError(
        'changes_undecided',
        `Checking whether the work of the space fits your project took longer than ${APPLY_TIMEOUT_MS / 1000} seconds, so nothing was changed. ${BRANCH_FROM_NOW_ON}`,
        { limitMs: APPLY_TIMEOUT_MS },
      );
    }
    const { change, patch, check } = prepared;
    if (check.code !== 0) {
      await close();
      // A file the user keeps out of git, by a global ignore file or info/exclude, that the space also
      // made: it was there before the space, so "your project changed" would not be true. Only a hint,
      // asked after the route is closed, so its failure changes nothing of the answer.
      const inTheWay = [];
      for (const file of change.created) {
        if (await exists(path.join(top, ...file.split('/')))) inTheWay.push(file);
      }
      const asked = inTheWay.length === 0 ? null : await g.run(top, ['check-ignore', '-z', '--stdin'], {
        stdin: inTheWay.map((file) => `${file}\0`).join(''), maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
      }).catch(() => null);
      const ignored = asked === null ? [] : asked.stdout.split('\0').filter(Boolean);
      const said = `Git said: ${tail(check.stderr) || `exit code ${check.code}`}`;
      // A file an LFS-like filter keeps, which the agent changed and an earlier apply wrote: git reads it
      // back through the filter as another file than the patch expects. Also only a hint, like the above.
      const filtered = ignored.length > 0 ? [] : await filteredInTheWay(call, readingBack(call), from, result).catch(() => []);
      if (filtered.length > 0) {
        const shown = reported(filtered);
        throw new SpaceError(
          'changes_do_not_apply',
          `The work of the space changes ${someOf(shown)} again, which a filter such as Git LFS handles in your project. Files like that cannot be updated as uncommitted changes a second time, so nothing was changed. ${BRANCH_FROM_NOW_ON}`,
          { exitCode: check.code, filteredInTheWay: shown },
        );
      }
      if (ignored.length > 0) {
        throw new SpaceError(
          'changes_do_not_apply',
          `Your project already has ${reported(ignored).paths[0]}, which git ignores here, and the work of the space adds a file of the same name, so nothing was changed. ${BRANCH_FROM_NOW_ON} ${said}`,
          { exitCode: check.code, ignoredInTheWay: reported(ignored) },
        );
      }
      // The patch goes from `from`: the start, or an apply that is still in the working tree.
      const since = from === start ? 'since the space was made' : 'since its work was last applied here';
      throw new SpaceError(
        'changes_do_not_apply',
        `The work of the space does not fit your project any more: your project changed ${since}, so nothing was changed now. ${BRANCH_FROM_NOW_ON} ${said}`,
        { exitCode: check.code },
      );
    }
    // The intent, what its patch was built from and HEAD now, before anything is written: a later call
    // that finds them knows an apply was under way, from where, and whether the user moved on since.
    await g.output(top, ['update-ref', '-m', `openchamber: applying the work of space ${spaceId}`, '--stdin'], {
      stdin: `update ${applyingRef(spaceId)} ${result}\nupdate ${applyingFromRef(spaceId)} ${from}\n${head ? `update ${applyingHeadRef(spaceId)} ${head}\n` : ''}`,
    });
    // With its tree on a timeout, as the dry run: the user's filters run as children of git here too. Not
    // at the server's exit, `keepAtExit`: an apply killed in the middle leaves a part in the project and
    // closes the route, where one left to run finishes and the next call records it.
    const done = await g.run(top, [...APPLY_ARGS, patch], {
      timeoutMs: APPLY_TIMEOUT_MS, maxOutputBytes: APPLY_OUTPUT_TAIL_BYTES, keepTail: true, killTree: true, keepAtExit: true,
    });
    if (done.code !== 0) {
      // The dry run passed and this did not, so some of the changes may be in the working tree. The
      // remembered ref stays where it was, because it no longer describes what is there.
      const recorded = await closeAndForget(result, from, head);
      throw new SpaceError(
        'changes_partly_applied',
        `Applying the work of the space stopped in the middle, so part of it may be in your project already: look at what changed. Your project is now in a state this cannot reason about. ${BRANCH_FROM_NOW_ON} Git said: ${tail(done.stderr) || `exit code ${done.code}`}`,
        { exitCode: done.code, recorded },
      );
    }
    // Only now, with the changes in the working tree: the next apply starts from here. When this fails,
    // the intent stays, and the next call finds the work in the working tree and finishes the record.
    const remembered = await g.run(top, ['update-ref', '-m', `openchamber: applied the work of space ${spaceId}`, '--stdin'], {
      stdin: `update ${appliedRef(spaceId)} ${result}\nupdate ${appliedFromRef(spaceId)} ${from}\n${headRecord(head)}${forgetIntent(result, from, head)}`,
    });
    return {
      status: 'applied',
      appliedPaths: change.changedPaths,
      remembered: remembered.code === 0,
      nestedRepositories: change.nestedRepositories,
      conflicted: await conflictedPaths(patch),
    };
  };

  /**
   * The key that one repository and one space share for their turn to apply: the repository's common
   * git folder, where every worktree of it keeps these refs, as its real path. Two linked worktrees of
   * one repository share the refs of a space, so an apply from one and an apply from the other take
   * turns too.
   */
  const applyTurnKey = async (g, top, spaceId) => {
    const common = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-common-dir'])));
    return `${await fs.realpath(common)}\0${spaceId}`;
  };

  return { bringCodeOut, applyAsBranch, applyAsChanges, describeApplyState };
}
