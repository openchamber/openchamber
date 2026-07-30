/**
 * The composer's local slash commands.
 *
 * Most of them do the same thing: render a pair of magic prompts — one the
 * user sees, one the model is instructed with — and send them as a single
 * message. That shape was previously written out nine times as an `else if`
 * chain, so adding a command meant copying twenty lines and remembering to
 * change every string in them. Here the shape is the executor and the
 * commands are data.
 *
 * Commands that are not "send a prompt pair" (undo, redo, timeline, compact,
 * handoff-review) stay with the composer: they manipulate session state or
 * open UI rather than producing a message.
 */

import type { I18nKey } from '@/lib/i18n';
import type { MagicPromptId } from '@/lib/magicPrompts';

/** What a command needs before it can run. */
export type CommandRequirement = 'session' | 'session-or-draft';

export interface MagicPromptCommand {
    /** The name typed after the slash. */
    name: string;
    /** Magic prompt shown to the user as their message. */
    visiblePrompt: MagicPromptId;
    /** Magic prompt attached as synthetic instructions for the model. */
    instructionsPrompt: MagicPromptId;
    /** i18n key for the toast shown when the command fails. */
    errorToastKey: I18nKey;
    requires: CommandRequirement;
    /**
     * Turn the text typed after the command name into template variables.
     * Commands without an argument omit this.
     */
    buildVariables?: (argument: string) => {
        visible?: Record<string, string>;
        instructions?: Record<string, string>;
    };
}

/**
 * `/summary rate limiting` focuses the summary on that topic. The topic is
 * woven into the visible message as a phrase and into the instructions as a
 * directive, so both read naturally when it is absent.
 */
const summaryVariables = (topic: string) => ({
    visible: { topic_line: topic ? ` focused on: ${topic}` : '' },
    instructions: {
        topic_block: topic
            ? `The user asked you to focus this summary on: ${topic}. Prioritize that topic; mention unrelated threads only in passing.`
            : '',
    },
});

/** `/craft-goal <idea>` and `/schedule-task <idea>` seed the prompt with the idea. */
const ideaVariables = (idea: string) => ({
    visible: { idea_block: idea ? `\n\nHere is my initial idea:\n${idea}` : '' },
});

export const MAGIC_PROMPT_COMMANDS: readonly MagicPromptCommand[] = [
    {
        name: 'summary',
        visiblePrompt: 'session.summary.visible',
        instructionsPrompt: 'session.summary.instructions',
        errorToastKey: 'chat.chatInput.toast.summaryFailed',
        // Summarizing needs a conversation to summarize.
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
    /** Everything typed after the command name, trimmed. */
    argument: string;
}

/**
 * Read the leading slash command out of a message, if there is one. Only the
 * first word counts as the command; the rest is its argument.
 */
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

/** The prompt-pair command for `name`, or null when it is not one. */
export function findMagicPromptCommand(name: string): MagicPromptCommand | null {
    return COMMANDS_BY_NAME.get(name) ?? null;
}

/** Whether the current session state satisfies the command's requirement. */
export function canRunCommand(
    command: MagicPromptCommand,
    state: { hasSession: boolean; hasDraft: boolean },
): boolean {
    return command.requires === 'session'
        ? state.hasSession
        : state.hasSession || state.hasDraft;
}

/** The template variables for both prompts of a command invocation. */
export function buildCommandVariables(
    command: MagicPromptCommand,
    argument: string,
): { visible: Record<string, string>; instructions: Record<string, string> } {
    const built = command.buildVariables?.(argument) ?? {};
    return {
        visible: built.visible ?? {},
        instructions: built.instructions ?? {},
    };
}
