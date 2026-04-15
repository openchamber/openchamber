import type { WorktreeMetadata } from '@/types/worktree';

/**
 * Shared session ↔ worktree attachment type.
 * This is the Phase 1 authoritative contract for session worktree state.
 * Stored in session-worktree-store.ts, consumed by all UI and sync logic.
 */
export type SessionWorktreeAttachment = {
  worktreeRoot: string | null;
  /** Effective runtime directory for the session. May differ from worktreeRoot for subdirectory sessions. */
  cwd: string | null;
  /** Latest known branch name, null if unborn or detached. */
  branch: string | null;
  /** Git HEAD state classification. */
  headState: 'branch' | 'detached' | 'unborn';
  /** Operational status of the attached worktree. */
  worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  /** How this worktree was attached to the session. */
  worktreeSource: 'existing' | 'created-for-session' | null;
  /** True when the session predates the worktree-attachment model and has no stored canonical attachment. */
  legacy: boolean;
  /** True when cwd resolved outside worktreeRoot or other degraded conditions. */
  degraded: boolean;
  /** Optional reason when the worktree is in an attention-required state. */
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
};

/** Input for resolving session worktree state. */
export type ResolveSessionWorktreeStateInput = {
  sessionDirectory: string | null;
  metadata: WorktreeMetadata | null;
  /** True when runtime has confirmed cwd exists on disk. */
  cwdExists?: boolean;
  /** Runtime-provided canonicalization result used for legacy recovery. */
  runtimeResolution?: SessionWorktreeAttachment | null;
};

/** Result of canonicalizing session worktree state. */
export type SessionWorktreeStateResolved = SessionWorktreeAttachment & {
  /** Computed: whether the cwd fell back to worktreeRoot. */
};

/** Result of validating a directory against a worktree root. */
export type WorktreeDirectoryValidation = {
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
};

/** Result of canonicalizing a directory to worktree state (runtime-backed). */
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

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const normalizePath = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.replace(/\/+$/, '') || replaced;
};

/**
 * Returns true if `candidate` is inside (or equal to) `worktreeRoot`.
 * Uses path prefix comparison after normalization.
 */
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

// ---------------------------------------------------------------------------
// Core canonicalization
// ---------------------------------------------------------------------------

/**
 * Resolve canonical session worktree state from directory + metadata.
 *
 * Rules:
 * - If runtimeResolution is provided, prefer it (legacy recovery path).
 * - If cwd is valid and inside worktreeRoot, keep it.
 * - Otherwise fall back to worktreeRoot and mark degraded.
 * - If no metadata is available, mark legacy with invalid status.
 */
export function resolveSessionWorktreeState(
  input: ResolveSessionWorktreeStateInput
): SessionWorktreeAttachment {
  const { sessionDirectory, metadata, cwdExists = true, runtimeResolution } = input;

  // Prefer runtime resolution for legacy recovery
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

  // No metadata — mark legacy and invalid
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

  // Determine if cwd is valid
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

// ---------------------------------------------------------------------------
// Badge formatting
// ---------------------------------------------------------------------------

/** Format a human-readable badge label from an attachment. */
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

/**
 * Derive the display branch label for a session.
 * Priority: authoritative attachment branch → live git branch → legacy metadata → catalog lookup.
 */
export function getAttachmentBranchLabel(input: {
  attachment: SessionWorktreeAttachment | null | undefined;
  liveGitBranch: string | null;
  legacyMetadataBranch: string | null;
  catalogBranch: string | null;
}): string | null {
  const { attachment, liveGitBranch, legacyMetadataBranch, catalogBranch } = input;

  // If attachment exists and has a branch, that is the session's true branch.
  // Even if live git shows something else (e.g. another session changed the shared directory),
  // the attachment is the source of truth.
  if (attachment && !attachment.degraded && !attachment.legacy) {
    return attachment.branch?.trim() || null;
  }

  // Fall back to live git, then legacy, then catalog
  return liveGitBranch || legacyMetadataBranch || catalogBranch;
}

// ---------------------------------------------------------------------------
// Repair actions
// ---------------------------------------------------------------------------

/** Phase 1 repair action IDs. */
export type SessionWorktreeRepairAction = 'locate' | 'open-without-worktree-features';

/** Return available repair actions for a degraded/missing session. */
export function getSessionWorktreeRepairActions(
  attachment: SessionWorktreeAttachment
): SessionWorktreeRepairAction[] {
  if (attachment.worktreeStatus === 'missing' || attachment.worktreeStatus === 'invalid') {
    return ['open-without-worktree-features'];
  }
  return [];
}

/** Reasons why a worktree mutation should be blocked. */
export type MutationBlockingReason =
  | { reason: 'dirty'; dirtyFiles?: number }
  | { reason: 'attention'; attentionReason: NonNullable<SessionWorktreeAttachment['attentionReason']> }
  | { reason: 'missing' }
  | { reason: 'invalid' };

/** Git status shape needed for dirty-tree detection. */
export type GitStatusForBlocking = {
  isClean: boolean;
  files?: unknown[];
};

/** Return blocking reasons that should prevent branch mutations. */
export function getMutationBlockingReasons(
  attachment: SessionWorktreeAttachment | null | undefined,
  gitStatus?: GitStatusForBlocking | null
): MutationBlockingReason[] {
  const reasons: MutationBlockingReason[] = [];
  if (gitStatus && !gitStatus.isClean) {
    reasons.push({ reason: 'dirty', dirtyFiles: Array.isArray(gitStatus.files) ? gitStatus.files.length : undefined });
  }
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

// ---------------------------------------------------------------------------
// Session target option builder
// ---------------------------------------------------------------------------

/** A labeled session target option for the new-session draft UI. */
export type SessionTargetOption = {
  value: string;
  label: string;
  kind: 'root' | 'worktree';
  /** True when this worktree is in pending bootstrap state. */
  pending?: boolean;
};

/** Build labeled target options for the new-session draft selector.
 *
 * Distinguishes:
 * - root: the project root / primary worktree
 * - worktree: an isolated secondary worktree
 * - pending: a worktree that is being bootstrapped (marked with pending=true)
 */
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
