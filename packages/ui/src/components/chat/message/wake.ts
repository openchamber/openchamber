import type { IconName } from '@/components/icon/icons';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { readShellCompletion, shellCompletionFailed, type ShellCompletion } from '@/lib/opencode/background-shell';
import { readDispatchedSessionResult } from '@/lib/opencode/dispatched-session';
import type { Message } from '@/lib/opencode/model';
import { readPromptOrigin } from '@/lib/opencode/prompt-origin';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { readSubagentRun } from '@/lib/opencode/subagent-run';
import { readShareAnswer } from '@/lib/share-pages/answer';
import { readWorkflowReport } from '@/lib/workflows/report';

export const NAME_SLOT = '\u0000';

type Translate = (key: I18nKey, params?: I18nParams) => string;

interface Wake {
    icon: IconName;
    failed: boolean;
    title: string;
    name: string;
}

export const shellWakeTitleKey = (completion: ShellCompletion): I18nKey => {
    if (completion.state === 'cancelled') return 'chat.exchange.commandStopped';
    return shellCompletionFailed(completion) ? 'chat.exchange.commandFailed' : 'chat.exchange.commandFinished';
};

const SUBAGENT_TITLES = {
    completed: 'chat.exchange.subagentFinished',
    error: 'chat.exchange.subagentFailed',
    cancelled: 'chat.exchange.subagentStopped',
} as const satisfies Record<string, I18nKey>;

const SESSION_TITLES = {
    completed: ['chat.dispatchedSession.completed', 'chat.dispatchedSession.completedUntitled'],
    error: ['chat.dispatchedSession.failed', 'chat.dispatchedSession.failedUntitled'],
    cancelled: ['chat.dispatchedSession.cancelled', 'chat.dispatchedSession.cancelledUntitled'],
} as const satisfies Record<string, readonly [I18nKey, I18nKey]>;

const WORKFLOW_TITLES = {
    completed: 'chat.workflow.report.completed',
    failed: 'chat.workflow.report.failed',
    stopped: 'chat.workflow.report.stopped',
    declined: 'chat.workflow.report.declined',
} as const satisfies Record<string, I18nKey>;

const failedIcon = (failed: boolean, icon: IconName): IconName => (failed ? 'error-warning' : icon);

export const readWake = (message: Message, t: Translate): Wake | undefined => {
    const run = readSubagentRun(message);
    if (run) {
        const failed = run.state === 'error';
        const name = run.description?.trim() || run.agent || '';
        return { icon: failedIcon(failed, run.state === 'cancelled' ? 'close-circle' : 'ai-agent'), failed, name, title: run.state === 'running' ? NAME_SLOT : t(SUBAGENT_TITLES[run.state], { title: NAME_SLOT }) };
    }
    const session = readDispatchedSessionResult(message);
    if (session) {
        const failed = session.state === 'error';
        const name = session.title?.trim() ?? '';
        const [titled, untitled] = SESSION_TITLES[session.state];
        return { icon: failedIcon(failed, session.state === 'cancelled' ? 'close-circle' : 'chat-ai-3'), failed, name, title: name ? t(titled, { title: NAME_SLOT }) : t(untitled) };
    }
    const workflow = readWorkflowReport(message);
    if (workflow) {
        const failed = workflow.state === 'failed';
        return { icon: failedIcon(failed, 'flow-chart'), failed, name: workflow.name, title: t(WORKFLOW_TITLES[workflow.state], { name: NAME_SLOT }) };
    }
    const share = readShareAnswer(message);
    if (share) return { icon: 'survey', failed: false, name: share.label, title: t('chat.sharePage.answer.titleUntitled', { label: NAME_SLOT }) };
    const shell = readShellCompletion(message);
    if (shell) {
        const failed = shell.state !== 'cancelled' && shellCompletionFailed(shell);
        return { icon: failedIcon(failed, shell.state === 'cancelled' ? 'close-circle' : 'terminal-box'), failed, name: '', title: t(shellWakeTitleKey(shell)) };
    }
    const origin = readPromptOrigin(message);
    if (origin) {
        const name = origin.title ?? '';
        return { icon: 'chat-ai-3', failed: false, name, title: name ? t('chat.message.userText.promptedBy', { title: NAME_SLOT }) : t('chat.message.userText.promptedByUnknown') };
    }
    const notice = readSessionNotice(message);
    if (notice?.kind === 'pull-request') return { icon: 'git-pull-request', failed: notice.events.includes('checks-failed'), name: '', title: `#${notice.number}` };
    if (notice?.kind === 'extension-wait') {
        const title = notice.timerMinutes !== undefined && notice.outcome === 'fired' ? t('chat.waits.timerFired', { minutes: notice.timerMinutes }) : notice.subject;
        return { icon: 'timer', failed: false, name: '', title };
    }
    return undefined;
};
