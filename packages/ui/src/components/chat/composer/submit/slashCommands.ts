
import type { I18nKey } from '@/lib/i18n';
import type { MagicPromptId } from '@/lib/magicPrompts';

type CommandRequirement = 'session' | 'session-or-draft';

export interface MagicPromptCommand {
    name: string;
    visiblePrompt: MagicPromptId;
    instructionsPrompt: MagicPromptId;
    errorToastKey: I18nKey;
    requires: CommandRequirement;
    buildVariables?: (argument: string) => {
        visible?: Record<string, string>;
        instructions?: Record<string, string>;
    };
}

const summaryVariables = (topic: string) => ({
    visible: { topic_line: topic ? ` focused on: ${topic}` : '' },
    instructions: {
        topic_block: topic
            ? `The user asked you to focus this summary on: ${topic}. Prioritize that topic; mention unrelated threads only in passing.`
            : '',
    },
});

const ideaVariables = (idea: string) => ({
    visible: { idea_block: idea ? `\n\nHere is my initial idea:\n${idea}` : '' },
});

export const MAGIC_PROMPT_COMMANDS: readonly MagicPromptCommand[] = [
    {
        name: 'summary',
        visiblePrompt: 'session.summary.visible',
        instructionsPrompt: 'session.summary.instructions',
        errorToastKey: 'chat.chatInput.toast.summaryFailed',
        requires: 'session',
        buildVariables: summaryVariables,
    },
    {
        name: 'workspace-review',
        visiblePrompt: 'session.review.visible',
        instructionsPrompt: 'session.review.instructions',
        errorToastKey: 'chat.chatInput.toast.reviewFailed',
        requires: 'session-or-draft',
    },
    {
        name: 'plan-feature',
        visiblePrompt: 'session.plan.visible',
        instructionsPrompt: 'session.plan.instructions',
        errorToastKey: 'chat.chatInput.toast.planFeatureFailed',
        requires: 'session-or-draft',
    },
    {
        name: 'craft-goal',
        visiblePrompt: 'session.craftGoal.visible',
        instructionsPrompt: 'session.craftGoal.instructions',
        errorToastKey: 'chat.chatInput.toast.craftGoalFailed',
        requires: 'session-or-draft',
        buildVariables: ideaVariables,
    },
    {
        name: 'schedule-task',
        visiblePrompt: 'session.scheduleTask.visible',
        instructionsPrompt: 'session.scheduleTask.instructions',
        errorToastKey: 'chat.chatInput.toast.scheduleTaskFailed',
        requires: 'session-or-draft',
        buildVariables: ideaVariables,
    },
    {
        name: 'catch-up',
        visiblePrompt: 'session.catchup.visible',
        instructionsPrompt: 'session.catchup.instructions',
        errorToastKey: 'chat.chatInput.toast.catchUpFailed',
        requires: 'session-or-draft',
    },
    {
        name: 'debug',
        visiblePrompt: 'session.debug.visible',
        instructionsPrompt: 'session.debug.instructions',
        errorToastKey: 'chat.chatInput.toast.debugFailed',
        requires: 'session-or-draft',
    },
    {
        name: 'weigh',
        visiblePrompt: 'session.weigh.visible',
        instructionsPrompt: 'session.weigh.instructions',
        errorToastKey: 'chat.chatInput.toast.weighFailed',
        requires: 'session-or-draft',
    },
    {
        name: 'explore',
        visiblePrompt: 'session.explore.visible',
        instructionsPrompt: 'session.explore.instructions',
        errorToastKey: 'chat.chatInput.toast.exploreFailed',
        requires: 'session-or-draft',
    },
];

const COMMANDS_BY_NAME = new Map(MAGIC_PROMPT_COMMANDS.map((command) => [command.name, command]));

export interface ParsedSlashCommand {
    name: string;
    argument: string;
}

export type LocalSlashCommandPlan = {
    command: ParsedSlashCommand;
    kind: 'action' | 'prompt';
    attachedContext: 'none' | 'retain' | 'send';
};

const LOCAL_ACTION_COMMANDS = new Set([
    'undo',
    'redo',
    'timeline',
    'handoff-review',
    'compact',
    'fork',
]);

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return null;

    const withoutSlash = trimmed.slice(1);
    const name = withoutSlash.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!name) return null;

    return {
        name,
        argument: withoutSlash.slice(name.length).trim(),
    };
}

export function planLocalSlashCommand(
    text: string,
    inputMode: 'normal' | 'shell' | undefined,
    hasAttachedContext: boolean,
    hasSession: boolean,
): LocalSlashCommandPlan | null {
    if (inputMode !== 'normal') return null;
    const command = parseSlashCommand(text);
    if (!command) return null;

    if (LOCAL_ACTION_COMMANDS.has(command.name)) {
        if (!hasSession) return null;

        return {
            command,
            kind: 'action',
            attachedContext: hasAttachedContext ? 'retain' : 'none',
        };
    }

    if (command.name === 'btw' || findMagicPromptCommand(command.name)) {
        return {
            command,
            kind: 'prompt',
            attachedContext: hasAttachedContext ? 'send' : 'none',
        };
    }

    return null;
}

export function findMagicPromptCommand(name: string): MagicPromptCommand | null {
    return COMMANDS_BY_NAME.get(name) ?? null;
}

export function canRunCommand(
    command: MagicPromptCommand,
    state: { hasSession: boolean; hasDraft: boolean },
): boolean {
    return command.requires === 'session'
        ? state.hasSession
        : state.hasSession || state.hasDraft;
}

export function buildCommandVariables(
    command: MagicPromptCommand,
    argument: string,
) {
    const built = command.buildVariables?.(argument) ?? {};
    return {
        visible: built.visible ?? {},
        instructions: built.instructions ?? {},
    };
}
