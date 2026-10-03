# E4: git over exec

Run on 2026-09-19. Host: macOS, git 2.50.1. Container: `node:22-bookworm-slim` plus git 2.39.5, user `agent` uid 1500, `--network none`, no mounts. Each claim says "tried" or "reasoned".

## Verdict

1. Yes. `git push` and `git fetch` over `ext::docker exec -i` carry code both ways with no network, ports, archives or mounts. Tried.
2. It is fast. A 93 MB repository with 3687 commits arrives in 3.8 s, a snapshot alone in 1.0 s. Tried.
3. It is safe enough if the host always drives, checks objects, fetches into a separate quarantine repository, and builds the patch itself. Two gaps need our own code: a size limit and a timeout.

## Recommended layout inside the container

A plain non-bare repository at `/spaces/<id>/<project>`, created with `git init`. The host pushes only to `refs/openchamber/*`, never to `refs/heads/*`, so `receive.denyCurrentBranch` never matters and needs no setting. The only config set inside is `receive.shallowUpdate=true`. Tried.

A bare repository plus a worktree also works, tried, but it adds a second path and a `.git` file for no gain. `receive.denyCurrentBranch=updateInstead` works, tried, but it lets a push rewrite the agent's working tree, which we never want.

## Recommended command sequences

`EXT="ext::docker exec -i <container> %S /spaces/abc123/bait"`. `G="git -c protocol.ext.allow=always"`. That flag goes on the transfer command only.

### Snapshot on the host, working tree and index untouched

Run with the user's normal git config, so the global ignore file still applies.

```sh
IDX=$(git rev-parse --git-path index); TMP=$(mktemp); cp "$IDX" "$TMP"
STAGED_TREE=$(GIT_INDEX_FILE=$TMP git write-tree)
GIT_INDEX_FILE=$TMP git add -A
WORK_TREE=$(GIT_INDEX_FILE=$TMP git write-tree); rm -f "$TMP"
BASE=$(git rev-parse HEAD)
STAGED=$(git commit-tree $STAGED_TREE -p $BASE -m "openchamber: staged snapshot")
START=$(git commit-tree $WORK_TREE -p $STAGED -m "openchamber: working tree snapshot")
git update-ref refs/openchamber/spaces/abc123/start $START
```

### In, snapshot first

```sh
# inside: git init /spaces/abc123/bait; git config receive.shallowUpdate true
S=$(mktemp -d); git init -q --bare $S
echo "$(git rev-parse --git-path objects)" > $S/objects/info/alternates
echo $BASE > $S/shallow
$G -C $S push "$EXT" $BASE:refs/openchamber/base
$G -C $S push "$EXT" $STAGED:refs/openchamber/start-index $START:refs/openchamber/start
rm -rf $S
# inside, unfold as uncommitted changes
git checkout -q -B <branch> refs/openchamber/start
git reset -q --soft refs/openchamber/base
git read-tree refs/openchamber/start-index
```

### In, history later

```sh
# inside: git init --bare /spaces/abc123/history.git
$G push "ext::docker exec -i <container> %S /spaces/abc123/history.git" $BASE:refs/openchamber/base
# inside
git fetch -q --unshallow --no-tags /spaces/abc123/history.git +refs/openchamber/base:refs/openchamber/base
rm -rf /spaces/abc123/history.git
```

### Out

Inside, build `refs/openchamber/result` with the same temp-index steps, parent `HEAD`. Then on the host:

```sh
Q=$(mktemp -d); git init -q --bare $Q
echo "$(git rev-parse --git-path objects)" > $Q/objects/info/alternates
FLAGS="--no-tags --no-recurse-submodules --no-write-fetch-head --no-auto-gc --refmap="
$G -C $Q -c fetch.fsckObjects=true -c transfer.fsckObjects=true fetch $FLAGS "$EXT" \
  +refs/openchamber/result:refs/openchamber/result
# our code: timeout on the process group, size cap on $Q, then promote
git -c fetch.fsckObjects=true fetch $FLAGS $Q \
  +refs/openchamber/result:refs/openchamber/spaces/abc123/result
rm -rf $Q
```

### Apply

```sh
NS=refs/openchamber/spaces/abc123
# a) as a branch, no checkout, working tree untouched
git branch space/abc123 $NS/result
# b) as uncommitted changes
git diff --binary --full-index --no-renames --no-ext-diff --no-textconv $NS/start $NS/result > $P
git apply --check --binary $P && git apply --binary $P
```

## Timings

Repository: a copy of OpenChamber `main`. 3687 commits, 5118 files, 93 MB pack. Local Colima. All tried.

| Step | Time | Bytes inside |
|---|---|---|
| Host snapshot, copied index | 0.18 s | |
| Host snapshot, empty temp index | 0.88 s | |
| Full history plus snapshot push | 3.76 s | 95 MB |
| Checkout inside | 0.6 to 0.7 s | |
| Parentless snapshot push | 0.98 s | 30 MB |
| History after the parentless snapshot | 4.23 s | 124 MB, the 30 MB travels twice |
| Shallow push from the temp sender, base then snapshot | 1.00 s + 0.10 s | 30 MB |
| History to the side repository, then local `--unshallow` | 4.35 s + 5.98 s | 103 MB |
| Reversed channel, `fetch --unshallow` from inside | 6.11 s | |
| Shallow temp clone on the host, then push | 0.95 s + 0.86 s | 30 MB |
| Bundle in, full history, `unbundle /dev/stdin` | 3.50 s | |
| Out, 2 commits plus snapshot, fetch | under 0.3 s | 1.4 KB as a bundle |

On local Docker the full push is already fast. Snapshot first pays off on Docker over SSH and on Kubernetes, where the link sets the speed.

## Hostile container results

| Attack | How | Result | Defence |
|---|---|---|---|
| Refs outside the refspec, `refs/heads/main` | tried | Host refs unchanged. Fetch writes only the destination we name | Explicit refspec, `--refmap=` |
| Tags | tried | No tag with `--no-tags`. The control run without it created two tags | `--no-tags` |
| Tree with `.git/hooks/pre-commit`, also `.GIT` | tried | Fetch fails, `hasDotgit`, no ref | `fetch.fsckObjects=true`. Without it, `git apply` still refuses with "invalid path" |
| Tree with `..` or `a/../../x` | tried | Fetch fails, `hasDotdot`, `fullPathname` | same |
| `.gitmodules` with url `-u./payload` | tried | Fetch fails, `gitmodulesUrl` | same |
| `.gitmodules` with an `ext::` url | tried | fsck accepts it. Nothing runs | `--no-recurse-submodules`. Never pass `protocol.ext.allow` to checkout or submodule commands |
| `.gitattributes` with `filter=evil` plus a config file in the tree | tried | Applied, nothing ran. Filter definitions live in config | Config does not travel. Host config sha unchanged after fetch, tried |
| Symlink pointing outside, then a write through it | tried | The second patch replaces the link with a real folder. Nothing outside was written | `git apply` default |
| Write through an ignored host symlink | tried | "beyond a symbolic link", nothing written | `git apply` default. Never pass `--unsafe-paths` |
| 60 MB blob | tried | Fetched in 2 s. Git has no fetch size limit | Quarantine repository plus our size cap. `ulimit -f` kills index-pack, tried, but leaves a 40 MB `tmp_pack_*` file |
| Fake upload-pack writes garbage | tried | "protocol error", exit 128, no ref | none needed |
| Fake upload-pack hangs | tried | Git waits forever. A 5 s watchdog that kills the process group works | Our timeout. The process inside the container survives the kill and needs its own cleanup |
| Hooks, `core.hooksPath`, `core.fsmonitor` | tried and reasoned | Config and hooks never travel. Fetch and apply run no hook from the space. The user's own `reference-transaction` and `post-checkout` hooks still run | `git branch` without checkout |
| Hostile receive-pack during push | reasoned | It can refuse, hang or lie about what it has. Lies only shrink the pack. It cannot ask for objects | Timeout |

## Findings

- `ext::` refuses to run without `-c protocol.ext.allow=always`. Tried. A push to a URL writes no remote and no config on the host.
- The host state was byte-identical before and after the snapshot and after the push: porcelain v2 status with ignored files, index sha, all refs, HEAD, every file hash. Tried. Status must run with `--no-optional-locks`, or it rewrites the index itself.
- The snapshot holds the modified, staged and untracked files, mode 100755, the symlink and the unicode name. It holds no `.env` and no `node_modules`. The secret is in no object inside. Tried.
- Two snapshot commits keep the staged and unstaged split. `git status --short` inside matched the host line for line. Tried. Lost: intent-to-add marks, stashes, conflict state, skip-worktree flags. Reasoned.
- The snapshot obeys ignore rules only. A secret in an untracked file that nobody ignores travels. Running the snapshot with global config disabled would drop the user's global ignore file and leak more. Reasoned. Show the list of untracked files that will travel.
- `git add -A` writes loose objects into the host `.git`, and runs the user's clean filters such as LFS. The working tree stays untouched. Reasoned.
- Pushing base and snapshot in one shallow push failed with "remote failed to report status" on git 2.39.5. Two pushes work. Tried.
- A push cannot deepen a shallow receiver. The sender sees that the receiver has the base and sends nothing, and pushing the parents is rejected with "missing necessary objects". Tried. A side repository plus local `fetch --unshallow` works and keeps every commit id.
- The reversed channel works, tried, but it needs a fifo, fd tricks, protocol v0 and a host `upload-pack` that the space talks to. The side repository is slower by 4 s and keeps the host as the only driver. I recommend it.
- The parentless snapshot works, tried, but agent commits then sit on a fake root. `git replace --graft` stays local to the space and `rebase --onto` rewrites commits under a running agent. Shallow is cleaner.
- `git --shallow-file` no longer exists in git 2.50. The alternates sender replaces it and copies nothing. Tried.
- A failed fetch leaves `tmp_pack_*` files in the target repository, 12 bytes after an fsck failure, 40 MB after a kill. Tried. This is why the fetch should land in a throwaway quarantine repository. After the quarantine run the user's pack folder was unchanged. Tried.
- The fetch changed one thing on the host, the quarantine ref. No FETCH_HEAD with `--no-write-fetch-head`. Tried.
- `git apply` is all or nothing. With a conflicting host edit, both the dry run and a real apply failed and the host state stayed byte-identical. Tried. After a clean apply the host working tree hashed to the same tree id as the result.
- `--3way` needs the index to match the working tree for touched files. It fails on a host with unstaged edits. Tried. Use plain apply, and offer the branch when it fails.
- The host builds the patch from two fetched trees. The space never supplies patch text. Binary files, mode changes, deletions, the symlink and the unicode name all round-trip. Tried.
- Killing the host side of `docker exec` leaves the process inside the container running. Tried.
- Bundles work. `git fetch /dev/stdin` fails, tried. `git bundle unbundle /dev/stdin` plus `update-ref` works in 3.5 s, tried. Out works as a host file plus `bundle verify` plus fetch. Bundles have no negotiation and need ref bookkeeping by hand. Keep them as the fallback for a place whose exec is not binary-safe.
- `docker -H ssh://`, `kubectl exec -i` and `container exec -i` should work. Reasoned. All three give binary-safe stdio without `-t` and pass exit codes. Git's pack protocol is length-framed, so it does not depend on stdin EOF, which older kubectl versions did not forward. Each `docker -H ssh://` call opens a new SSH session, so count calls.
- Windows: Git for Windows ships `git-remote-ext`. Reasoned. `ext::` splits on spaces itself and uses `% ` for a literal space, so keep container names and paths free of spaces and pass the URL as one argv element without a shell.

## What this changes in DESIGN.md

- "Quarantine ref namespace" becomes a quarantine repository first, then the ref namespace. Add the size cap and the timeout as host code.
- "Send the snapshot first and the history in the background" needs the mechanism named: shallow push from a temp sender, then a side repository and a local unshallow. Push alone cannot deepen.
- The start snapshot must be kept as a host ref, `refs/openchamber/spaces/<id>/start`. Otherwise gc can prune it and the patch has no base. This is host state inside the user's repository, next to the "no state file" rule.
- The staged and unstaged split survives. Say so.
- Add a creation warning: untracked files that are not ignored travel into the space.
- "Apply as a branch" should create the branch without checking it out.
- Every exec needs cleanup inside the space after a host-side kill.

## Not verified

- `docker -H ssh://`, `kubectl exec`, Apple `container exec`, and any Windows host.
- Whether fetch from a bundle file honours `fetch.fsckObjects`.
- Submodules, LFS, sparse checkout, linked worktrees on the host, SHA-256 repositories.
- Behaviour with a newer git inside the container, mainly the one-push shallow failure.
- Repositories over 1 GB, and timings over a slow link.
- The "Bad command" line that `git-remote-ext` printed once during a quiet fetch. The fetch succeeded.
