import React from 'react';
import { RiShieldCheckLine, RiFileWarningLine } from '@remixicon/react';
import type { GitHubBranchProtection } from '@/lib/api/types';

interface ProtectionBannerProps {
  protection?: GitHubBranchProtection | null;
  prMergeable?: boolean | null;
}

export const ProtectionBanner: React.FC<ProtectionBannerProps> = ({ protection, prMergeable }) => {
  if (!protection) {
    return null;
  }

  if (!protection.enabled) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-[hsl(var(--status-warning-background))] px-3 py-2 text-[hsl(var(--status-warning))]">
        <RiFileWarningLine className="size-4 shrink-0" />
        <span className="typography-micro">No branch protection rules.</span>
      </div>
    );
  }

  const blocks: string[] = [];
  if (protection.requiredStatusChecks?.contexts && protection.requiredStatusChecks.contexts.length > 0) {
    blocks.push(`${protection.requiredStatusChecks.contexts.length} required status check(s)`);
  }
  if (protection.requiredReviews && protection.requiredReviews.requiredApprovingReviewCount > 0) {
    blocks.push(`${protection.requiredReviews.requiredApprovingReviewCount} approving review(s) required`);
  }
  if (protection.enforceAdmins) {
    blocks.push('admin enforcement');
  }

  const canMerge = prMergeable !== false;

  return (
    <div className={`flex items-center gap-2 rounded-md px-3 py-2 ${canMerge ? 'bg-[hsl(var(--status-success-background))] text-[hsl(var(--status-success))]' : 'bg-[hsl(var(--status-error-background))] text-[hsl(var(--status-error))]'}`}>
      {canMerge ? <RiShieldCheckLine className="size-4 shrink-0" /> : <RiFileWarningLine className="size-4 shrink-0" />}
      <span className="typography-micro">
        {canMerge
          ? `Branch protection: ${blocks.join(', ') || 'enabled'}`
          : `Cannot merge: ${blocks.join(', ') || 'branch protection blocks merge'}`}
      </span>
    </div>
  );
};
