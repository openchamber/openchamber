import type { Part } from '@opencode-ai/sdk/v2';
import {
    GITHUB_ISSUE_CONTEXT_PREFIX,
    GITHUB_PR_CONTEXT_PREFIX,
    GITLAB_ISSUE_CONTEXT_PREFIX,
    GITLAB_MR_CONTEXT_PREFIX,
    GITEA_ISSUE_CONTEXT_PREFIX,
    GITEA_PR_CONTEXT_PREFIX,
    startsWithForgeContextPrefix,
} from '@/lib/messages/synthetic';
import { readContextPart } from '@/lib/messages/contextParts';

type IssueContextPayload = {
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

type GitLabMrContextPayload = {
    mr?: {
        number?: unknown;
        title?: unknown;
        url?: unknown;
    };
};

type GiteaPrContextPayload = {
    pr?: {
        number?: unknown;
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

const buildForgeAttachmentPart = (text: string): Part | null => {
    // GitHub issues
    const ghIssuePayload = parseSyntheticJsonPayload<IssueContextPayload>(text, GITHUB_ISSUE_CONTEXT_PREFIX);
    if (ghIssuePayload) {
        const issue = ghIssuePayload.issue;
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

    // GitHub PRs
    const ghPrPayload = parseSyntheticJsonPayload<GitHubPrContextPayload>(text, GITHUB_PR_CONTEXT_PREFIX);
    if (ghPrPayload) {
        const pr = ghPrPayload.pr;
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

    // GitLab issues
    const glIssuePayload = parseSyntheticJsonPayload<IssueContextPayload>(text, GITLAB_ISSUE_CONTEXT_PREFIX);
    if (glIssuePayload) {
        const issue = glIssuePayload.issue;
        const number = issue?.number;
        const title = issue?.title;
        const url = issue?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitlab.issue-link',
            filename: `Issue #${number}: ${title}`,
            url,
        } as Part;
    }

    // GitLab MRs
    const glMrPayload = parseSyntheticJsonPayload<GitLabMrContextPayload>(text, GITLAB_MR_CONTEXT_PREFIX);
    if (glMrPayload) {
        const mr = glMrPayload.mr;
        const number = mr?.number;
        const title = mr?.title;
        const url = mr?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitlab.merge-request-link',
            filename: `MR !${number}: ${title}`,
            url,
        } as Part;
    }

    // Gitea issues
    const gtIssuePayload = parseSyntheticJsonPayload<IssueContextPayload>(text, GITEA_ISSUE_CONTEXT_PREFIX);
    if (gtIssuePayload) {
        const issue = gtIssuePayload.issue;
        const number = issue?.number;
        const title = issue?.title;
        const url = issue?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitea.issue-link',
            filename: `Issue #${number}: ${title}`,
            url,
        } as Part;
    }

    // Gitea PRs
    const gtPrPayload = parseSyntheticJsonPayload<GiteaPrContextPayload>(text, GITEA_PR_CONTEXT_PREFIX);
    if (gtPrPayload) {
        const pr = gtPrPayload.pr;
        const number = pr?.number;
        const title = pr?.title;
        const url = pr?.url;
        if (!isPositiveNumber(number) || typeof title !== 'string' || typeof url !== 'string') {
            return null;
        }
        return {
            type: 'file',
            mime: 'application/vnd.gitea.pull-request-link',
            filename: `PR #${number}: ${title}`,
            url,
        } as Part;
    }

    return null;
};

const forgeContextFilePart = (
    kind: string,
    payload: { number: number; title: string; url: string },
): Part | null => {
    switch (kind) {
        case 'github-issue':
            return { type: 'file', mime: 'application/vnd.github.issue-link', filename: `Issue #${payload.number}: ${payload.title}`, url: payload.url } as Part;
        case 'github-pr':
            return { type: 'file', mime: 'application/vnd.github.pull-request-link', filename: `PR #${payload.number}: ${payload.title}`, url: payload.url } as Part;
        case 'gitlab-issue':
            return { type: 'file', mime: 'application/vnd.gitlab.issue-link', filename: `Issue #${payload.number}: ${payload.title}`, url: payload.url } as Part;
        case 'gitlab-mr':
            return { type: 'file', mime: 'application/vnd.gitlab.merge-request-link', filename: `MR !${payload.number}: ${payload.title}`, url: payload.url } as Part;
        case 'gitea-issue':
            return { type: 'file', mime: 'application/vnd.gitea.issue-link', filename: `Issue #${payload.number}: ${payload.title}`, url: payload.url } as Part;
        case 'gitea-pr':
            return { type: 'file', mime: 'application/vnd.gitea.pull-request-link', filename: `PR #${payload.number}: ${payload.title}`, url: payload.url } as Part;
        default:
            return null;
    }
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
                || startsWithForgeContextPrefix(normalizedText);
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
                    if (contextPayload && 'number' in contextPayload && 'title' in contextPayload && 'url' in contextPayload) {
                        const filePart = forgeContextFilePart(contextPayload.kind, {
                            number: contextPayload.number,
                            title: contextPayload.title,
                            url: contextPayload.url,
                        });
                        if (filePart) return filePart;
                    }
                    if (contextPayload) {
                        return part;
                    }
                    const attachmentPart = buildForgeAttachmentPart(text);
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
