# Comments

The pieces every inline-comment surface shares: writing one on a line range
(`useInlineCommentController`, `useWholeFileComment`, the comment field and its
image paste), drawing it over a diff or a preview, and reopening what a comment
was written on (`useOpenCommentSource`).

## Ownership

This folder owns the comment *flow* — selection to draft, draft to composer.
The surfaces that host it own their own selection mechanics and their own
diff/preview rendering: `views/FilesView.tsx`, `views/PlanView.tsx`,
`views/PierreDiffViewer.tsx` and its comment overlays, and the phone's diff
screens. Draft storage belongs to `stores/useInlineCommentDraftStore.ts`, and
what a draft becomes in the chat to `lib/messages/contextParts.ts`.

## Invariants

- A draft is shown only on the surface it was written on:
  `diffCommentOriginKey` matches source, file and origin. A comment on a
  comparison and a comment on the same path in the working tree are different
  comments.

## Decisions

### Why a comparison comment reopens in its diff and not in the file

A comment on a commit, a branch comparison or a change request names lines of a
version that is published or historical, so the file on disk is a different
version and may not have those lines at all. `useOpenCommentSource` therefore
routes the three origins into the Changes diff for that comparison and leaves
the line in `useUIStore.pendingCommentLocation`; only a comment on uncommitted
changes or a file quote opens a file. The alternative — always opening the
file and letting the line land wherever it does now — was rejected as wrong
rather than merely imprecise: it would show text the comment never quoted.

A branch comparison is the checkout against its base, so a comment written on a
branch that is not the one checked out cannot name a line: its base is kept for
that branch, and the comparison opens without a line request. The request names
the folder it belongs to, so another folder's panel never takes it. A change
request whose host an older message did not record matches the host the surface
knows, so it still lands on its line; one that lives in a repository below the
folder is opened through the folder's own comparison, which is the board's
limit here too.

### Why the surface decides whether the button exists

A runtime that cannot show the comparison offers no button for a comparison
comment: VS Code's comment threads and editor open files, so a commit or pull
request comment there would land on another version. `canOpen` is therefore a
question about the pair (source, origin) in the current runtime, not the
source alone, and the reveal is only offered where opening it cannot lie.
