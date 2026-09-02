import type { Part } from '@opencode-ai/sdk/v2';
import { readContextPart } from '@/lib/messages/contextParts';

const GITHUB_ISSUE_CONTEXT_PREFIX = 'GitHub issue context (JSON)';
const GITHUB_PR_CONTEXT_PREFIX = 'GitHub pull request context (JSON)';
const LINEAR_ISSUE_CONTEXT_PREFIX = 'Linear issue context (JSON)';

type GitHubIssueContextPayload = {
    issue?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type GitHubPrContextPayload = {
    pr?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type LinearIssueContextPayload = {
    issue?: {
        identifier?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

const isPositiveNumber = (value: unknown): value is number => {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

const parseSyntheticJsonPayload = <T>(text: string, prefix: string): T | null => {
    const normalizedText = text.trimStart();
    if (!normalizedText.startsWith(prefix)) {
        return null;
    }

    const jsonStart = normalizedText.indexOf('{');
    if (jsonStart < 0) {
        return null;
    }

    try {
        return JSON.parse(normalizedText.slice(jsonStart)) as T;
    } catch {
        return null;
    }
};

const buildGitHubAttachmentPart = (text: string): Part | null => {
    const issuePayload = parseSyntheticJsonPayload<GitHubIssueContextPayload>(text, GITHUB_ISSUE_CONTEXT_PREFIX);
    if (issuePayload) {
        const issue = issuePayload.issue;
        const number = issue?.number;
        const title = issue?.title;
        const url = issue?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }

        return {
            type: 'file',
            mime: 'application/vnd.github.issue-link',
            filename: `Issue #${number}: ${title}`,
            url,
        } as Part;
    }

    const prPayload = parseSyntheticJsonPayload<GitHubPrContextPayload>(text, GITHUB_PR_CONTEXT_PREFIX);
    if (prPayload) {
        const pr = prPayload.pr;
        const number = pr?.number;
        const title = pr?.title;
        const url = pr?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }

        return {
            type: 'file',
            mime: 'application/vnd.github.pull-request-link',
            filename: `PR #${number}: ${title}`,
            url,
        } as Part;
    }

    const linearPayload = parseSyntheticJsonPayload<LinearIssueContextPayload>(text, LINEAR_ISSUE_CONTEXT_PREFIX);
    if (linearPayload) {
        const issue = linearPayload.issue;
        const identifier = issue?.identifier;
        const title = issue?.title;
        const url = issue?.url;
        if (typeof identifier !== 'string' || identifier.trim().length === 0 || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }

        return {
            type: 'file',
            mime: 'application/vnd.openchamber.linear-issue-link',
            filename: `${identifier}: ${title}`,
            url,
        } as Part;
    }

    return null;
};

const shouldKeepSyntheticUserText = (text: string, planModeEnabled: boolean): boolean => {
    const trimmed = text.trim();
    if (planModeEnabled && trimmed.startsWith('User has requested to enter plan mode')) return true;
    if (planModeEnabled && trimmed.startsWith('The plan at ')) return true;
    if (trimmed.startsWith('The following tool was executed by the user')) return true;
    return false;
};

export const normalizeUserDisplayParts = (parts: Part[], options?: { planModeEnabled?: boolean }): Part[] => {
    const planModeEnabled = options?.planModeEnabled === true;
    return parts
        .filter((part) => {
            const synthetic = (part as { synthetic?: boolean }).synthetic === true;
            if (!synthetic) return true;
            if (part.type !== 'text') return false;
            if (readContextPart(part)) return true;
            const text = (part as { text?: unknown }).text;
            if (typeof text !== 'string') {
                return false;
            }

            const normalizedText = text.trimStart();
            return shouldKeepSyntheticUserText(text, planModeEnabled)
                || normalizedText.startsWith(GITHUB_ISSUE_CONTEXT_PREFIX)
                || normalizedText.startsWith(GITHUB_PR_CONTEXT_PREFIX)
                || normalizedText.startsWith(LINEAR_ISSUE_CONTEXT_PREFIX);
        })
        .map((part) => {
            const rawPart = part as Record<string, unknown>;
            if (rawPart.type === 'compaction') {
                return { type: 'text', text: '/compact' } as Part;
            }
            if (rawPart.type === 'text') {
                const text = typeof rawPart.text === 'string' ? rawPart.text.trim() : '';
                const synthetic = rawPart.synthetic === true;

                if (synthetic) {
                    const contextPayload = readContextPart(part);
                    if (contextPayload?.kind === 'github-issue' || contextPayload?.kind === 'github-pr' || contextPayload?.kind === 'linear-issue') {
                        // SAFETY: same display-only file-part shape the legacy
                        // buildGitHubAttachmentPart produces; consumed by
                        // FileAttachment, which matches on the mime type.
                        if (contextPayload.kind === 'linear-issue') {
                            return {
                                type: 'file',
                                mime: 'application/vnd.openchamber.linear-issue-link',
                                filename: `${contextPayload.identifier}: ${contextPayload.title}`,
                                url: contextPayload.url,
                            } as Part;
                        }
                        return {
                            type: 'file',
                            mime: contextPayload.kind === 'github-issue'
                                ? 'application/vnd.github.issue-link'
                                : 'application/vnd.github.pull-request-link',
                            filename: contextPayload.kind === 'github-issue'
                                ? `Issue #${contextPayload.number}: ${contextPayload.title}`
                                : `PR #${contextPayload.number}: ${contextPayload.title}`,
                            url: contextPayload.url,
                        } as Part;
                    }
                    if (contextPayload) {
                        // Other context kinds render through UserContextPart.
                        return part;
                    }
                    // Legacy messages: sniff the pre-metadata text format.
                    const attachmentPart = buildGitHubAttachmentPart(text);
                    if (attachmentPart) {
                        return attachmentPart;
                    }
                }

                if (text.startsWith('The following tool was executed by the user')) {
                    return { type: 'text', text: '/shell' } as Part;
                }
            }
            return part;
        });
};
