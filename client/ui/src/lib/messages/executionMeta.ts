export const MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT =
    "This message bellow comes from an AI agent in another session. I want you to act according to its content: " +
    "if it is an implementation plan, your task is to implement that plan; " +
    "if it is a conclusion or summary, your task is to verify it, explain whether you agree or disagree, and correct it if needed; " +
    "if it is a bug description, find the root cause and fix it. " +
    "Proceed with actions right away based on your understanding of the task. " +
    "Here is the content of the message: ";

// Default, user-editable instructions prefilled in the "Start new session from
// this answer" dialog. Mirrors the previous fixed fork instruction so existing
// behavior is preserved unless the user edits it.
export const EXECUTION_FORK_DEFAULT_INSTRUCTIONS =
    "I want you to respond according to the content of message I share: " +
    "if it is an implementation plan, your task is to implement that plan; " +
    "if it is a conclusion or summary, your task is to verify it, explain whether you agree or disagree, and correct it if needed. " +
    "Always clearly state what you understand your task to be, and wait for the user's approval of your conclusions before taking any further actions.";

// Fixed connective that opens the forked assistant content. Not editable by the
// user — it sits between the user's instructions and the assistant message.
const EXECUTION_FORK_CONTENT_PREFACE =
    "This message below comes from an AI agent in another session. Here is the content of the message:";

// Builds the final message sent to the new session:
//   <user instructions>
//
//   This message below comes from an AI agent in another session. Here is the content of the message:
//   <assistant content>
export const composeForkSessionMessage = (instructions: string, assistantContent: string): string =>
    `${instructions.trim()}\n\n${EXECUTION_FORK_CONTENT_PREFACE}\n${assistantContent}`;
