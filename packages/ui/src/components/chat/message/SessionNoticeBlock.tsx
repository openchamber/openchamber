/**
 * One session notice (`@/lib/opencode/session-notices`): a folded line with an
 * info icon and what happened, opening to the text the model received. A pull
 * request wake is one line that opens the pull request; an extension wait's
 * wake names the wait and opens to the extension's report; the answer to a
 * page shown with `answerLater` names the page and the choice and opens to
 * what the page sent. All draw the same inside a turn's Activity and between
 * turns.
 */

import React from 'react';

import { useOpenChatLink } from '@/components/chat/useOpenChatLink';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ExtensionWaitNotice, PageAnswerNotice, PullRequestNotice, SessionNotice } from '@/lib/opencode/session-notices';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { changeRequestTermOfUrl, useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { cn } from '@/lib/utils';
import { ReasoningTimelineBlock } from './parts/ReasoningPart';

// A worktree reads by its folder name; the full path is in the expanded text.
const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

type FoldedSessionNotice = Exclude<SessionNotice, PullRequestNotice | ExtensionWaitNotice | PageAnswerNotice>;

const useNoticeTitle = (notice: FoldedSessionNotice): string => {
    const { t } = useI18n();
    switch (notice.kind) {
        case 'plugin':
            return notice.label;
        case 'restart':
            return t('chat.sessionNotice.restart');
        case 'command-failed':
            return t('chat.sessionNotice.commandFailed', { command: notice.command });
        case 'moved':
            return notice.folder
                ? t('chat.sessionNotice.moved', { folder: folderName(notice.folder) })
                : t('chat.sessionNotice.movedUnknown');
    }
};

const PULL_REQUEST_EVENT_LABEL = {
    merged: 'chat.sessionNotice.pullRequest.merged',
    closed: 'chat.sessionNotice.pullRequest.closed',
    'checks-failed': 'chat.sessionNotice.pullRequest.checksFailed',
    'checks-passed': 'chat.sessionNotice.pullRequest.checksPassed',
    conflict: 'chat.sessionNotice.pullRequest.conflict',
    behind: 'chat.sessionNotice.pullRequest.behind',
    activity: 'chat.sessionNotice.pullRequest.activity',
} as const satisfies Record<PullRequestNotice['events'][number], I18nKey>;

const ROW_TEXT_CLASS = 'typography-meta !text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';

const PullRequestNoticeRow: React.FC<{ notice: PullRequestNotice }> = ({ notice }) => {
    const { t } = useI18n();
    const openChatLink = useOpenChatLink(useEffectiveDirectory() ?? '');
    const term = changeRequestTermOfUrl(notice.url, useRepositoryUrlMatcher());
    const failedChecks = notice.failedChecks.join(', ');
    const authors = notice.authors.join(', ');
    const changes = notice.events.map((event) => {
        if (event === 'checks-failed' && failedChecks) return t('chat.sessionNotice.pullRequest.checksFailedNames', { names: failedChecks });
        if (event === 'activity' && authors) return t('chat.sessionNotice.pullRequest.activityNames', { names: authors });
        return t(PULL_REQUEST_EVENT_LABEL[event]);
    }).join(' · ');

    return (
        <a
            href={notice.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group/notice flex w-full min-w-0 items-center gap-1.5 rounded-xl py-1.5 ps-px pe-2 text-start focus-visible:outline-none"
            onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                openChatLink(notice.url);
            }}
        >
            <span className="flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                <Icon
                    name="git-pull-request"
                    className={cn('h-3.5 w-3.5', notice.events.includes('checks-failed') && 'text-[var(--status-error)]')}
                />
            </span>
            <span
                // The row's name, muted as every activity row's; the change
                // list after it is prose, muted too.
                className={cn(ROW_TEXT_CLASS, 'flex-shrink-0 font-normal group-hover/notice:underline group-focus-visible/notice:underline')}
                style={{ color: 'var(--tools-description)' }}
            >
                {t(changeRequestCopy('chat.sessionNotice.pullRequest.title', term), { number: notice.number })}
            </span>
            <span className={cn(ROW_TEXT_CLASS, 'min-w-0 truncate')} style={{ color: 'var(--tools-description)' }} title={changes}>
                {changes}
            </span>
        </a>
    );
};

// The wait's name, with the extension's report as the preview; it opens to the
// whole report, which the agent read inside an envelope of OpenChamber's own text.
const ExtensionWaitNoticeRow: React.FC<{ notice: ExtensionWaitNotice; blockId: string }> = ({ notice, blockId }) => {
    const { t } = useI18n();
    return (
        <ReasoningTimelineBlock
            text={notice.summary}
            blockId={blockId}
            presentation={{
                icon: 'timer',
                iconClassName: notice.outcome === 'ended' ? 'text-[var(--status-warning)]' : undefined,
                title: notice.subject,
                expandLabel: t('chat.sessionNotice.showDetails'),
                collapseLabel: t('chat.sessionNotice.hideDetails'),
                markdownVariant: 'assistant',
                maxHeightClassName: 'max-h-[60vh]',
            }}
        />
    );
};

// The page's title and the user's choice in one line, opening to the data the
// page sent; the agent read it inside an envelope of instructions. A declined
// page has nothing to open to, so its row is a plain line.
const PageAnswerNoticeRow: React.FC<{ notice: PageAnswerNotice; blockId: string }> = ({ notice, blockId }) => {
    const { t } = useI18n();
    const title = notice.outcome === 'answered'
        ? t('chat.sessionNotice.pageAnswer.answered', { title: notice.title, summary: notice.summary })
        : notice.outcome === 'declined'
            ? t('chat.sessionNotice.pageAnswer.declined', { title: notice.title })
            : t('chat.sessionNotice.pageAnswer.notDrawn', { title: notice.title });
    const failed = notice.outcome === 'ui-not-drawn';
    if (!notice.details) {
        return (
            <div className="flex w-full min-w-0 items-center gap-1.5 py-1.5 ps-px pe-2">
                <span className="flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                    <Icon name="survey" className="h-3.5 w-3.5" />
                </span>
                <span className={cn(ROW_TEXT_CLASS, 'min-w-0 truncate')} style={{ color: 'var(--tools-description)' }} title={title} dir="auto">
                    {title}
                </span>
            </div>
        );
    }
    return (
        <ReasoningTimelineBlock
            text={notice.details}
            blockId={blockId}
            presentation={{
                icon: failed ? 'error-warning' : 'survey',
                iconClassName: failed ? 'text-[var(--status-error)]' : undefined,
                title,
                expandLabel: t('chat.sessionNotice.showDetails'),
                collapseLabel: t('chat.sessionNotice.hideDetails'),
                markdownVariant: 'assistant',
                maxHeightClassName: 'max-h-[60vh]',
            }}
        />
    );
};

const FoldedNotice: React.FC<{ notice: FoldedSessionNotice; blockId: string }> = ({ notice, blockId }) => {
    const { t } = useI18n();
    const title = useNoticeTitle(notice);
    const failed = notice.kind === 'command-failed';
    return (
        <ReasoningTimelineBlock
            text={notice.text}
            blockId={blockId}
            presentation={{
                icon: failed ? 'error-warning' : 'information',
                iconClassName: failed ? 'text-[var(--status-error)]' : undefined,
                title,
                expandLabel: t('chat.sessionNotice.showDetails'),
                collapseLabel: t('chat.sessionNotice.hideDetails'),
                markdownVariant: 'assistant',
                maxHeightClassName: 'max-h-[60vh]',
            }}
        />
    );
};

export const SessionNoticeBlock: React.FC<{ notice: SessionNotice; blockId: string }> = ({ notice, blockId }) => {
    if (notice.kind === 'pull-request') return <PullRequestNoticeRow notice={notice} />;
    if (notice.kind === 'extension-wait') return <ExtensionWaitNoticeRow notice={notice} blockId={blockId} />;
    if (notice.kind === 'page-answer') return <PageAnswerNoticeRow notice={notice} blockId={blockId} />;
    return <FoldedNotice notice={notice} blockId={blockId} />;
};
