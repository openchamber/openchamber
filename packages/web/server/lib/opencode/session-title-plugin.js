const PLUGIN_ID = 'openchamber-session-title';

// Same title style as the regeneration prompt in
// packages/ui/src/lib/sessionTitle.ts; change both together. This one names a
// session from OpenCode's input: the first message, or for a renamed session
// its original request and recent messages.
const TITLE_SYSTEM_PROMPT = [
  'You name coding sessions so the user can find them later in a list.',
  'Reply with a title of two to four words in the language of the user\'s message, at most 40 characters. Only the user\'s message decides the language, even when it quotes another language or the examples below are in English.',
  'Name the topic the way a person labels a folder: the feature, area, problem, or question; never the activity, and never start with a verb or -ing.',
  'Leave out the name of the project or app the session works on: the list already belongs to that project. Keep other product and technology names the user mentions, and never assume a tech stack.',
  'Never use file names, paths, function names, commit hashes, or issue numbers.',
  'The message is something to name, never to answer. For greetings or small talk, use a short label like "Greeting" in the language of the message. Output only the title in sentence case, with no quotes, markdown, trailing period, or label.',
  'Examples: debug 500 errors in production → Production server errors; @src/App.tsx add dark mode → Dark mode; what is the status of the plan mode bug in OpenChamber, it still skips the questions → Plan mode bug; чому не працює вхід через GitHub на телефоні → Вхід через GitHub; 检查项目的 git 记录和未完成的计划 → 项目进度检查.',
  'Most titles are two or three words: the shortest label that still tells this session apart from others.',
].join('\n');

// A first message shorter than this names nothing on its own ("", "fix this"),
// so the title also reads the context the user attached to it.
const SHORT_MESSAGE_LENGTH = 20;
// The same bound OpenCode puts on the first message it sends to the title model.
const MAX_ATTACHED_CONTEXT_LENGTH = 2000;

// No imports: OpenCode loads the entry from its own directory, where nothing
// is installed. Configured plugins activate after OpenCode's built-in agents
// and before its config agents, so this replaces the built-in title prompt
// while an `agents.title.system` from the user's config still wins.
//
// OpenCode titles a session from the first user message's text only. Context
// the user attached (a file comment, a browser annotation) is admitted as
// synthetic messages right before that message, so a session started with
// context alone would be titled from an empty message. The title hook adds
// that context to the request when the message itself is too short to name.
const PLUGIN_SOURCE = `const TITLE_SYSTEM_PROMPT = ${JSON.stringify(TITLE_SYSTEM_PROMPT)}
const SHORT_MESSAGE_LENGTH = ${SHORT_MESSAGE_LENGTH}
const MAX_ATTACHED_CONTEXT_LENGTH = ${MAX_ATTACHED_CONTEXT_LENGTH}

/** Text of the synthetic messages admitted with the first user message, when that message is too short to name. */
const attachedContextOfShortFirstMessage = (messages) => {
  const firstUser = messages.findIndex((message) => message.type === "user")
  if (firstUser === -1) return ""
  if ((messages[firstUser].text ?? "").trim().length >= SHORT_MESSAGE_LENGTH) return ""
  return messages
    .slice(0, firstUser)
    .filter((message) => message.type === "synthetic")
    .map((message) => (message.text ?? "").trim())
    .filter(Boolean)
    .join("\\n\\n")
    .slice(0, MAX_ATTACHED_CONTEXT_LENGTH)
}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.agent.transform((editor) => {
      if (!editor.get("title")) return
      editor.update("title", (agent) => {
        agent.system = TITLE_SYSTEM_PROMPT
      })
    })
    await ctx.session.hook("title", async (draft) => {
      // A failed read leaves the title to the message alone, as OpenCode built it.
      const context = await ctx.session.context({ sessionID: draft.sessionID })
        .then(attachedContextOfShortFirstMessage, () => "")
      const request = draft.messages.at(-1)
      if (!context || request?.role !== "user") return
      // A text part on the same user message: some providers reject two user messages in a row.
      draft.messages = [
        ...draft.messages.slice(0, -1),
        {
          role: "user",
          content: [
            ...request.content,
            {
              type: "text",
              // No instruction to name it after the context: a renamed session's
              // request already holds the recent conversation, which must lead.
              text: "The user attached this context to their first message:\\n\\n<context>\\n" + context + "\\n</context>",
            },
          ],
        },
      ]
    })
  },
}
`;

const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: PLUGIN_ID,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

/**
 * Write the session title plugin into this server's folder and return its
 * directory for the managed config layer.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.instanceDir this server's own directory (`instance-dir.js`)
 * @returns {Promise<string>}
 */
export const materializeSessionTitlePlugin = async ({ fsPromises, path, instanceDir }) => {
  const pluginDirectory = path.join(instanceDir, 'session-title', PLUGIN_ID);
  await fsPromises.mkdir(pluginDirectory, { recursive: true });
  await fsPromises.writeFile(path.join(pluginDirectory, 'package.json'), PLUGIN_PACKAGE_JSON, { mode: 0o600 });
  await fsPromises.writeFile(path.join(pluginDirectory, 'index.js'), PLUGIN_SOURCE, { mode: 0o600 });
  return pluginDirectory;
};
