import type { Part } from "@opencode-ai/sdk/v2";

export const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
export const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';
export const GITLAB_ISSUE_CONTEXT_PREFIX = 'GitLab issue context (JSON)';
export const GITLAB_MR_CONTEXT_PREFIX = 'GitLab merge request context (JSON)';
export const GITEA_ISSUE_CONTEXT_PREFIX = 'Gitea issue context (JSON)';
export const GITEA_PR_CONTEXT_PREFIX = 'Gitea pull request context (JSON)';

export const FORGE_CONTEXT_PREFIXES = [
    GITHUB_ISSUE_CONTEXT_PREFIX,
    GITHUB_PR_CONTEXT_PREFIX,
    GITLAB_ISSUE_CONTEXT_PREFIX,
    GITLAB_MR_CONTEXT_PREFIX,
    GITEA_ISSUE_CONTEXT_PREFIX,
    GITEA_PR_CONTEXT_PREFIX,
];

export const startsWithForgeContextPrefix = (text: string): boolean =>
    FORGE_CONTEXT_PREFIXES.some((prefix) => text.startsWith(prefix));

export const isSyntheticPart = (part: Part | undefined): boolean => {
    if (!part || typeof part !== "object") {
        return false;
    }
    return Boolean((part as { synthetic?: boolean }).synthetic);
};

/**
 * Checks if a message consists entirely of synthetic parts.
 * Used for status/completion logic (not display filtering).
 */
export const isFullySyntheticMessage = (parts: Part[] | undefined): boolean => {
    if (!Array.isArray(parts) || parts.length === 0) {
        return false;
    }

    return parts.every((part) => isSyntheticPart(part));
};

/**
 * Filters out synthetic parts from a message, but only if there are
 * non-synthetic parts present. If all parts are synthetic, returns
 * them as-is so the message can still be displayed.
 */
export const filterSyntheticParts = (parts: Part[] | undefined): Part[] => {
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    const hasNonSynthetic = parts.some((part) => !isSyntheticPart(part));

    const shouldKeepSyntheticPart = (part: Part): boolean => {
        if (!isSyntheticPart(part) || part.type !== 'text') {
            return false;
        }

        const text = (part as { text?: unknown }).text;
        if (typeof text !== 'string') {
            return false;
        }

        const trimmed = text.trimStart();
        return startsWithForgeContextPrefix(trimmed);
    };

    // If there are non-synthetic parts, filter out synthetic ones
    if (hasNonSynthetic) {
        // Optimization: Check if there are actually any synthetic parts to filter.
        // If not, return the original array to preserve referential equality.
        const hasSynthetic = parts.some((part) => isSyntheticPart(part));
        if (!hasSynthetic) {
            return parts;
        }
        return parts.filter((part) => !isSyntheticPart(part) || shouldKeepSyntheticPart(part));
    }

    // If all parts are synthetic, return them all (so message is displayed)
    return parts;
};
