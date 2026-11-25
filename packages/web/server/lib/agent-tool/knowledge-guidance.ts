export const KNOWLEDGE_TOOL_DESCRIPTION = "The project's Notes, Todos and Plans, shown in OpenChamber's Project knowledge panel and shared by its sessions. One action per call; list returns everything unless planId or ready narrows it. "
  + "Notes: short facts the user wants at hand; your own learnings go to the project's agent docs or memory. Todos: the user's backlog; add one when asked or when you stop with work left, never for the steps of your current task. "
  + "A note or todo may belong to a plan (planId), and a todo may depend on other todos of that plan (dependsOn); list with ready for the todos that can start. "
  + "Plans: markdown files. list gives their paths; read and edit them with your file tools, save creates or replaces one whole. A new plan the user asks to save goes through save, in Plan mode too: the panel does not show a file written elsewhere, such as in ~/.opencode/plan. Write one there only when the user asks for a file. A plan starts with a # title, then a ## Steps heading with one - [ ] item per coarse step, then the detail. A plan written for the user: save, show, wait for their comments; they send it to a session. Implementing one: tick each step (- [x]) as you finish it and change nothing else unless asked; never drop a constraint. "
  + "Replacing a note or plan: pass expected. If the save fails on it, refresh and retry the save with the same id.";

const PLAN_SAVE_NOTE = `<system-update>
In Plan mode, a plan the user asks to save goes to Project knowledge: call knowledge.save with kind plan through the openchamber_knowledge tool, which Plan mode allows. Write a plan file in the Plan mode folder only when the user asks for a file; that request does not go to Project knowledge.
</system-update>`;

export const PLAN_SAVE_NOTE_HELPER = `const notePlanSaves = (draft) => {
  draft.messages = draft.messages.flatMap((message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text" || !/^<system-(update|reminder)>\\nYou are in Plan mode\\./.test(part.text)) return [message]
    return [message, { role: "user", content: [{ type: "text", text: ${JSON.stringify(PLAN_SAVE_NOTE)} }] }]
  })
}
`;
