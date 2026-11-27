import { isPlainObject } from '../shared/guards.js';
import { isSourceControlInteger, isSourceControlString as isString } from './input-guards.js';
import type { SourceControlJson, SourceControlJsonObject } from '@openchamber/sdk';

export interface ReviewDraftContext {
  target: { number?: number; headSha?: string };
}

interface ReviewDraftDependencies<Body extends string | undefined = string | undefined> {
  commentText(value: SourceControlJson | undefined, required: true): Body;
  fail(message: string): never;
  fileComments?: boolean;
}

const PATH_MAX_LENGTH = 4096;
const COMMENT_ID_RE = /^[\w:=-]{1,200}$/;

export function reviewCommentPosition(body: SourceControlJsonObject, fail: ReviewDraftDependencies['fail']) {
  if (!isString(body.path) || !body.path || body.path.length > PATH_MAX_LENGTH) fail('path is invalid');
  if (body.line === undefined) {
    if (body.startLine !== undefined || body.side !== undefined) fail('A comment on a whole file has no lines');
    return { path: body.path };
  }
  if (body.side !== 'old' && body.side !== 'new') fail('side is invalid');
  if (!isSourceControlInteger(body.line) || body.line < 1) fail('line is invalid');
  if (body.startLine === undefined) return { path: body.path, side: body.side, line: body.line };
  if (!isSourceControlInteger(body.startLine) || body.startLine < 1 || body.startLine >= body.line) fail('startLine is invalid');
  return { path: body.path, side: body.side, startLine: body.startLine, line: body.line };
}

export function reviewDraftEntries<Body extends string | undefined>({ commentText, fail, fileComments = true }: ReviewDraftDependencies<Body>) {
  const requireTarget = (context: ReviewDraftContext) => {
    if (!context.target.number) fail('target number is required');
  };
  const commentId = (value: SourceControlJson | undefined) => {
    const id = isString(value) || Number.isSafeInteger(value) ? String(value) : '';
    if (!COMMENT_ID_RE.test(id)) fail('commentId is invalid');
    return id;
  };
  return {
    '/pr/review/comment': {
      kind: 'change-request-review-comment',
      normalize: (input: SourceControlJsonObject, context: ReviewDraftContext) => {
        requireTarget(context);
        if (!context.target.headSha) fail('target head SHA is required');
        const position = reviewCommentPosition(isPlainObject(input) ? input : {}, fail);
        if (!fileComments && !('line' in position)) fail('This host comments on lines only, not on a whole file');
        const body = commentText(input.body, true);
        return { position, body, digest: { ...position, body } };
      },
    },
    '/pr/review/comment/update': {
      kind: 'change-request-review-comment-update',
      normalize: (input: SourceControlJsonObject, context: ReviewDraftContext) => {
        requireTarget(context);
        const id = commentId(input.commentId);
        const body = commentText(input.body, true);
        return { commentId: id, body, digest: { commentId: id, body } };
      },
    },
    '/pr/review/comment/delete': {
      kind: 'change-request-review-comment-delete',
      normalize: (input: SourceControlJsonObject, context: ReviewDraftContext) => {
        requireTarget(context);
        const id = commentId(input.commentId);
        return { commentId: id, digest: { commentId: id } };
      },
    },
    '/pr/review/discard': {
      kind: 'change-request-review-discard',
      normalize: (_input: SourceControlJsonObject, context: ReviewDraftContext) => {
        requireTarget(context);
        return { digest: {} };
      },
    },
  };
}

export function pairedDiffLine(patch: string | null | undefined, side: 'old' | 'new', line: number) {
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
