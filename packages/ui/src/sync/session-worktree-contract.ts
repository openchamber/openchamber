import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionWorktreeAttachment } from '@/stores/types/sessionTypes';

export type ResolveSessionWorktreeStateInput = {
  sessionDirectory: string | null;
  metadata: WorktreeMetadata | null;
  cwdExists?: boolean;
  runtimeResolution?: SessionWorktreeAttachment | null;
};

export type WorktreeDirectoryValidation = {
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
};

export type WorktreeCanonicalizationResult = {
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
};

export type SessionWorktreeCanonicalizationOptions = {
  existingAttachment?: SessionWorktreeAttachment | null;
  fallbackDirectory?: string | null;
  worktreeSource?: SessionWorktreeAttachment['worktreeSource'];
};

const normalizePath = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '') || replaced;
};

export function isWithinWorktreeRoot(candidate: string | null, worktreeRoot: string | null): boolean {
  if (!candidate || !worktreeRoot) return false;
  const c = normalizePath(candidate);
  const r = normalizePath(worktreeRoot);
  return c === r || c.startsWith(r + '/');
}

export function getAttachedSessionDirectory(
  attachment: SessionWorktreeAttachment | null | undefined,
  fallbackDirectory?: string | null,
): string | null {
  if (attachment) {
    if (!attachment.degraded && attachment.cwd) {
      return normalizePath(attachment.cwd);
    }
    if (attachment.worktreeRoot) {
      return normalizePath(attachment.worktreeRoot);
    }
    if (attachment.cwd) {
      return normalizePath(attachment.cwd);
    }
  }

  if (fallbackDirectory) {
    return normalizePath(fallbackDirectory);
  }

  return null;
}

export function buildAttachmentFromCanonicalization(
  canonical: WorktreeCanonicalizationResult,
  options: SessionWorktreeCanonicalizationOptions = {},
): SessionWorktreeAttachment {
  const existingAttachment = options.existingAttachment ?? null;
  const fallbackDirectory = options.fallbackDirectory ?? null;
  const preferredDirectory = canonical.degraded
    ? canonical.worktreeRoot ?? canonical.cwd ?? fallbackDirectory
    : canonical.cwd ?? canonical.worktreeRoot ?? fallbackDirectory;

  return {
    worktreeRoot: canonical.worktreeRoot ?? fallbackDirectory,
    cwd: preferredDirectory,
    branch: canonical.branch ?? existingAttachment?.branch ?? null,
    headState: canonical.headState,
    worktreeStatus: canonical.worktreeStatus,
    worktreeSource: options.worktreeSource ?? existingAttachment?.worktreeSource ?? null,
    legacy: canonical.legacy,
    degraded: canonical.degraded,
    attentionReason: canonical.attentionReason ?? null,
  };
}

export function resolveSessionWorktreeState(
  input: ResolveSessionWorktreeStateInput
): SessionWorktreeAttachment {
  const { sessionDirectory, metadata, cwdExists = true, runtimeResolution } = input;

  if (runtimeResolution) {
    return {
      worktreeRoot: runtimeResolution.worktreeRoot ?? metadata?.path ?? sessionDirectory ?? null,
      cwd: runtimeResolution.cwd ?? sessionDirectory ?? metadata?.path ?? null,
      branch: runtimeResolution.branch ?? metadata?.branch ?? null,
      headState: runtimeResolution.headState ?? 'branch',
      worktreeStatus: runtimeResolution.worktreeStatus ?? 'ready',
      worktreeSource: runtimeResolution.worktreeSource ?? metadata?.source === 'sdk' ? 'created-for-session' : 'existing',
      legacy: false,
      degraded: runtimeResolution.degraded,
      attentionReason: runtimeResolution.attentionReason ?? null,
    };
  }

  if (!metadata) {
    return {
      worktreeRoot: sessionDirectory ?? null,
      cwd: sessionDirectory ?? null,
      branch: null,
      headState: 'branch',
      worktreeStatus: sessionDirectory ? 'invalid' : 'not-a-repo',
      worktreeSource: null,
      legacy: true,
      degraded: true,
      attentionReason: null,
    };
  }

  const worktreeRoot = metadata.worktreeRoot ?? metadata.path;
  const cwd = sessionDirectory ?? worktreeRoot;

  const cwdValid = cwdExists && (cwd === worktreeRoot || isWithinWorktreeRoot(cwd, worktreeRoot));

  return {
    worktreeRoot,
    cwd: cwdValid ? cwd : worktreeRoot,
    branch: metadata.branch ?? null,
    headState: metadata.headState ?? (metadata.branch ? 'branch' : 'detached'),
    worktreeStatus: metadata.worktreeStatus ?? 'ready',
    worktreeSource: metadata.source === 'sdk' ? 'created-for-session' : 'existing',
    legacy: false,
    degraded: !cwdValid,
    attentionReason: null,
  };
}

export function formatSessionWorktreeBadge(attachment: SessionWorktreeAttachment): string {
  if (attachment.legacy) return 'Legacy session';
  if (attachment.worktreeStatus === 'missing') return 'Worktree missing';
  if (attachment.worktreeStatus === 'not-a-repo') return 'Not a repo';
  if (attachment.worktreeStatus === 'invalid') return 'Needs attention';
  if (attachment.attentionReason) return 'Needs attention';
  if (attachment.headState === 'detached') return 'Detached HEAD';
  if (attachment.headState === 'unborn') return 'Unborn branch';
  if (attachment.branch) return `Current branch: ${attachment.branch}`;
  return 'No branch';
}

export type SessionWorktreeRepairAction = 'locate' | 'open-without-worktree-features';

export function getSessionWorktreeRepairActions(
  attachment: SessionWorktreeAttachment
): SessionWorktreeRepairAction[] {
  if (attachment.worktreeStatus === 'missing' || attachment.worktreeStatus === 'invalid') {
    return ['open-without-worktree-features'];
  }
  return [];
}

export type MutationBlockingReason =
  | { reason: 'attention'; attentionReason: NonNullable<SessionWorktreeAttachment['attentionReason']> }
  | { reason: 'missing' }
  | { reason: 'invalid' };

export function getMutationBlockingReasons(
  attachment: SessionWorktreeAttachment | null | undefined
): MutationBlockingReason[] {
  const reasons: MutationBlockingReason[] = [];
  if (!attachment) return reasons;
  if (attachment.worktreeStatus === 'missing') {
    reasons.push({ reason: 'missing' });
  }
  if (attachment.worktreeStatus === 'invalid') {
    reasons.push({ reason: 'invalid' });
  }
  if (attachment.attentionReason) {
    reasons.push({ reason: 'attention', attentionReason: attachment.attentionReason });
  }
  return reasons;
}

export type SessionTargetOption = {
  value: string;
  label: string;
  kind: 'root' | 'worktree';
  pending?: boolean;
};

export function buildSessionTargetOptions(input: {
  projectRoot: string;
  rootBranch: string;
  worktrees: Array<{ path: string; branch: string; label: string; projectDirectory: string }>;
  pendingBootstrapDirectory?: string | null;
}): SessionTargetOption[] {
  const options: SessionTargetOption[] = [];

  if (input.projectRoot) {
    options.push({
      value: input.projectRoot,
      label: input.rootBranch || input.projectRoot.split('/').pop() || input.projectRoot,
      kind: 'root',
    });
  }

  const pendingNormalized = input.pendingBootstrapDirectory
    ? normalizePath(input.pendingBootstrapDirectory)
    : null;

  for (const wt of input.worktrees) {
    const normalizedPath = normalizePath(wt.path);
    if (normalizedPath === input.projectRoot) continue;
    const isPending = normalizedPath === pendingNormalized;
    options.push({
      value: normalizedPath,
      label: wt.branch?.trim() || wt.label || normalizedPath.split('/').pop() || normalizedPath,
      kind: 'worktree',
      pending: isPending || undefined,
    });
  }

  return options;
}
