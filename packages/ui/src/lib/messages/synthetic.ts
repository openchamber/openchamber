import type { Part } from "@opencode-ai/sdk/v2";
import type { HarnessPart } from "@openchamber/harness-contracts";

type SyntheticPartRecord = Part | HarnessPart;

const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';

export const isSyntheticPart = (part: SyntheticPartRecord | undefined): boolean => {
    if (!part || typeof part !== "object") {
        return false;
    }
    return Boolean((part as { synthetic?: boolean }).synthetic);
};

/**
 * Checks if a message consists entirely of synthetic parts.
 * Used for status/completion logic (not display filtering).
 */
export const isFullySyntheticMessage = (parts: SyntheticPartRecord[] | undefined): boolean => {
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
        if (!isSyntheticPart(part) || getPartKind(part) !== 'text') {
            return false;
        }

        const text = (part as { text?: unknown }).text;
        if (typeof text !== 'string') {
            return false;
        }

        const trimmed = text.trimStart();
        return trimmed.startsWith(GITHUB_ISSUE_CONTEXT_PREFIX) || trimmed.startsWith(GITHUB_PR_CONTEXT_PREFIX);
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

function getPartKind(part: SyntheticPartRecord): string | undefined {
    if ('kind' in part) return part.kind;
    return part.type;
}
