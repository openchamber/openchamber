import React from 'react';

import { commentComparisonScope, commentRepository, pullRequestSourceOf, type CommentLocationRequest } from '@/lib/commentLocation';
import { changeRequestMoved, sameCommentOrigin, shortRef, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { normalizePath } from '@/lib/pathNormalization';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';

import { useTakenCommentLocation } from './useTakenCommentLocation';

import { isFindRevealFor, patchShowsLine } from '@/components/views/diffView/diffData';
import type { ComparisonDiffResult, DiffScope, FileEntry } from '@/components/views/diffView/types';

type ScrollTarget = { filePath: string; lineNumber: number; side: 'additions' | 'deletions' };
type PendingLine = { comparisonKey: string | null; target: ScrollTarget };

const entryShowsLine = (entry: ComparisonDiffResult | undefined, target: ScrollTarget, hideWhitespace: boolean): boolean | null => {
  if (!entry || entry.status === 'loading' || entry.status === 'error') return null;
  if (entry.status === 'ready' && (entry.data.contextMode === 'full' || entry.data.patch === undefined)) return true;
  if (entry.status === 'large' && entry.contextMode === 'full') return true;
  if (hideWhitespace) return false;
  const patch = entry.status === 'large' ? entry.patch : entry.data.patch ?? '';
  return patchShowsLine(patch, target.lineNumber, target.side);
};

const isOnBranch = (request: CommentLocationRequest, branch: string | null): boolean => (
  request.origin.kind === 'branch' && branch !== null && shortRef(request.origin.headRef) === branch
);

export function requestCommentPullRequest(directory: string, request: CommentLocationRequest): void {
  if (request.origin.kind !== 'change-request') return;
  usePullRequestSelectionStore.getState().requestDiff(directory, pullRequestSourceOf(request.origin));
}

export function useCommentJumpComparison(options: {
  takeFrom: string | null | undefined;
  visible: boolean;
  scope: DiffScope;
  directory: string | undefined;
  branch: string | null;
}) {
  const { takeFrom, visible, scope, directory, branch } = options;
  const { jump, done } = useTakenCommentLocation(takeFrom, visible);
  const key = JSON.stringify([directory ?? null, branch]);
  const [shownBase, setShownBase] = React.useState<{ key: string; base: string } | null>(null);

  React.useEffect(() => {
    if (!jump || jump.origin.kind !== 'branch' || !isOnBranch(jump, branch)) return;
    if (normalizePath(commentRepository(jump)) !== normalizePath(directory ?? '')) return;
    setShownBase({ key, base: jump.origin.baseRef });
  }, [branch, directory, jump, key]);

  React.useEffect(() => {
    if (!visible || scope !== 'branch') setShownBase(null);
  }, [scope, visible]);

  const leave = React.useCallback(() => {
    done();
    setShownBase(null);
  }, [done]);
  return {
    jump,
    done,
    leave,
    commitHash: jump?.origin.kind === 'commit' ? jump.origin.hash : null,
    branchBase: shownBase?.key === key && scope === 'branch' ? shownBase.base : null,
  };
}

export function useAnswerCommentJump(options: {
  commentJump: { jump: CommentLocationRequest | null; done: () => void; leave: () => void };
  scope: DiffScope;
  directory: string | undefined;
  branch: string | null;
  branchBaseMissing: boolean;
  statusLoaded: boolean;
  hideWhitespace: boolean;
  commentOrigin: DiffCommentOrigin | undefined;
  comparison: { key: string | null; files: readonly unknown[] | null; error: string | null };
  withheldPullRequest: number | null;
  changedFiles: readonly FileEntry[];
  filesShown: boolean;
  comparisonEntry: (path: string) => ComparisonDiffResult | undefined;
  openComparison: (origin: CommentLocationRequest['origin']) => void;
  revealFile: (path: string) => void;
  scrollToLocation: (target: ScrollTarget) => void;
}) {
  const {
    commentJump: { jump, done, leave }, scope, directory, branch, branchBaseMissing, statusLoaded, hideWhitespace, commentOrigin, comparison, withheldPullRequest, changedFiles,
    filesShown, comparisonEntry, revealFile, scrollToLocation,
  } = options;
  const openComparisonRef = React.useRef(options.openComparison);
  openComparisonRef.current = options.openComparison;
  const { key: comparisonKey, files: comparisonFiles, error: comparisonError } = comparison;
  const startedRef = React.useRef<CommentLocationRequest | null>(null);
  const [wholeFile, setWholeFile] = React.useState<{ comparisonKey: string | null; path: string } | null>(null);
  const [pendingLine, setPendingLine] = React.useState<PendingLine | null>(null);

  React.useEffect(() => {
    const request = jump;
    if (!request) return;
    if (normalizePath(commentRepository(request)) !== normalizePath(directory ?? '')
      || scope !== commentComparisonScope(request.origin)) {
      done();
      return;
    }
    if (request.origin.kind === 'branch') {
      if (branch === null) return;
      if (!isOnBranch(request, branch)) {
        done();
        return;
      }
      if (branchBaseMissing) {
        leave();
        return;
      }
    }
    if (request.origin.kind === 'commit' && !statusLoaded) return;
    if (startedRef.current !== request) {
      startedRef.current = request;
      if (directory) requestCommentPullRequest(directory, request);
      openComparisonRef.current(request.origin);
    }
    if (request.origin.kind === 'change-request' && scope === 'pr' && withheldPullRequest === request.origin.number) {
      done();
      return;
    }
    if (changeRequestMoved(commentOrigin, request.origin)) {
      done();
      return;
    }
    if (!sameCommentOrigin(commentOrigin, request.origin)) return;
    if (comparisonError !== null) {
      done();
      return;
    }
    if (comparisonFiles === null) return;
    const rowPath = changedFiles.find((file) => file.path === request.filePath || isFindRevealFor(file.path, request.filePath))?.path;
    if (rowPath === undefined) {
      done();
      return;
    }
    if (!filesShown) return;
    done();
    revealFile(rowPath);
    if (request.line === null) return;
    setPendingLine({ comparisonKey, target: { filePath: rowPath, lineNumber: request.line, side: request.side } });
  }, [
    branch, branchBaseMissing, changedFiles, commentOrigin, comparisonError, comparisonFiles, comparisonKey, directory, done, filesShown, jump,
    leave, revealFile, scope, statusLoaded, withheldPullRequest,
  ]);

  const pendingEntry = pendingLine ? comparisonEntry(pendingLine.target.filePath) : undefined;
  React.useEffect(() => {
    if (!pendingLine) return;
    if (pendingLine.comparisonKey !== comparisonKey || !filesShown) {
      setPendingLine(null);
      return;
    }
    if (pendingEntry?.status === 'error') {
      setPendingLine(null);
      return;
    }
    const shown = entryShowsLine(pendingEntry, pendingLine.target, hideWhitespace);
    if (shown === null) return;
    setPendingLine(null);
    if (!shown) setWholeFile({ comparisonKey, path: pendingLine.target.filePath });
    scrollToLocation(pendingLine.target);
  }, [comparisonKey, filesShown, hideWhitespace, pendingEntry, pendingLine, scrollToLocation]);

  return React.useCallback(
    (path: string) => wholeFile !== null && wholeFile.path === path && wholeFile.comparisonKey === comparisonKey,
    [comparisonKey, wholeFile],
  );
}
