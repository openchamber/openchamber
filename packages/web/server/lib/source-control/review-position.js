import { isPlainObject, isString } from '../shared/guards.js';

/**
 * What every provider's review draft shares: where a comment sits, the shell
 * routes that change a draft, and reading a unified diff for a host that needs
 * both sides of a line (GitLab refuses an unchanged line named by one side).
 */

const PATH_MAX_LENGTH = 4096;
const COMMENT_ID_RE = /^[\w:=-]{1,200}$/;

/** The position in `body`: lines of one side, or without `line` the whole file. `fail(message)` throws the caller's error. */
export function reviewCommentPosition(body, fail) {
  if (!isString(body.path) || !body.path || body.path.length > PATH_MAX_LENGTH) fail('path is invalid');
  if (body.line === undefined) {
    if (body.startLine !== undefined || body.side !== undefined) fail('A comment on a whole file has no lines');
    return { path: body.path };
  }
  if (body.side !== 'old' && body.side !== 'new') fail('side is invalid');
  if (!Number.isSafeInteger(body.line) || body.line < 1) fail('line is invalid');
  if (body.startLine === undefined) return { path: body.path, side: body.side, line: body.line };
  if (!Number.isSafeInteger(body.startLine) || body.startLine < 1 || body.startLine >= body.line) fail('startLine is invalid');
  return { path: body.path, side: body.side, startLine: body.startLine, line: body.line };
}

/**
 * The shell routes that change a draft, as a mutation table's entries.
 * `commentText(value, required)` validates text the way the provider does.
 */
export function reviewDraftEntries({ commentText, fail }) {
  const requireTarget = (context) => {
    if (!context.target.number) fail('target number is required');
  };
  const commentId = (value) => {
    const id = isString(value) || Number.isSafeInteger(value) ? String(value) : '';
    if (!COMMENT_ID_RE.test(id)) fail('commentId is invalid');
    return id;
  };
  return {
    '/pr/review/comment': {
      kind: 'change-request-review-comment',
      normalize: (input, context) => {
        requireTarget(context);
        if (!context.target.headSha) fail('target head SHA is required');
        const position = reviewCommentPosition(isPlainObject(input) ? input : {}, fail);
        const body = commentText(input.body, true);
        return { position, body, digest: { ...position, body } };
      },
    },
    '/pr/review/comment/update': {
      kind: 'change-request-review-comment-update',
      normalize: (input, context) => {
        requireTarget(context);
        const id = commentId(input.commentId);
        const body = commentText(input.body, true);
        return { commentId: id, body, digest: { commentId: id, body } };
      },
    },
    '/pr/review/comment/delete': {
      kind: 'change-request-review-comment-delete',
      normalize: (input, context) => {
        requireTarget(context);
        const id = commentId(input.commentId);
        return { commentId: id, digest: { commentId: id } };
      },
    },
    '/pr/review/discard': {
      kind: 'change-request-review-discard',
      normalize: (_input, context) => {
        requireTarget(context);
        return { digest: {} };
      },
    },
  };
}

/**
 * Both line numbers of `line` on `side` in one file's hunks: `{ oldLine,
 * newLine }`, null for the side a changed line does not have. Null when the
 * hunks do not show that line.
 */
export function pairedDiffLine(patch, side, line) {
  let oldLine = 0;
  let newLine = 0;
  for (const row of String(patch ?? '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (oldLine === 0 && newLine === 0) continue;
    if (row.startsWith('\\')) continue;
    let pair = null;
    if (row.startsWith('+')) pair = { oldLine: null, newLine: newLine++ };
    else if (row.startsWith('-')) pair = { oldLine: oldLine++, newLine: null };
    else if (row.startsWith(' ')) pair = { oldLine: oldLine++, newLine: newLine++ };
    if (pair && (side === 'old' ? pair.oldLine : pair.newLine) === line) return pair;
  }
  return null;
}
