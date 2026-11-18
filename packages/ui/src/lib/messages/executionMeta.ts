export const MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT =
    "This message bellow comes from an AI agent in another session. I want you to act according to its content: " +
    "if it is an implementation plan, your task is to implement that plan; " +
    "if it is a conclusion or summary, your task is to verify it, explain whether you agree or disagree, and correct it if needed; " +
    "if it is a bug description, find the root cause and fix it. " +
    "Proceed with actions right away based on your understanding of the task. " +
    "Here is the content of the message: ";

export const EXECUTION_FORK_DEFAULT_INSTRUCTIONS =
    "I want you to respond according to the content of message I share: " +
    "if it is an implementation plan, your task is to implement that plan; " +
    "if it is a conclusion or summary, your task is to verify it, explain whether you agree or disagree, and correct it if needed. " +
    "Always clearly state what you understand your task to be, and wait for the user's approval of your conclusions before taking any further actions.";

export const EXECUTION_FORK_GOAL_INSTRUCTIONS =
    "The message I share is an assignment handed over from another AI agent. Extract the concrete task from it and start executing immediately: " +
    "if it is an implementation plan, implement that plan; " +
    "if it is a conclusion or summary, verify it against the actual current state of the code and correct it if needed; " +
    "if it is a bug description, find the root cause and fix it. " +
    "Do not stop at restating your understanding and do not wait for approval — keep working until the task is verifiably complete.";

const EXECUTION_FORK_CONTENT_PREFACE =
    "This message below comes from an AI agent in another session. Here is the content of the message:";

export const composeForkSessionMessage = (instructions: string, assistantContent: string): string =>
    `${instructions.trim()}\n\n${EXECUTION_FORK_CONTENT_PREFACE}\n${assistantContent}`;
