const PLUGIN_ID = 'openchamber-session-title';

const TITLE_SYSTEM_PROMPT = [
  'You name coding sessions so the user can find them later in a list.',
  'Reply with a title of two to four words in the language of the user\'s message, at most 40 characters. Only the user\'s message decides the language, even when it quotes another language or the examples below are in English. Words inside a path or file name count only when the message has no other words: `read ~/plans/sync.md` is English, `阅读 ~/plans/sync.md` is Chinese, and `~/plans/sync.md` alone is English.',
  'Name the topic the way a person labels a folder: the feature, area, problem, or question; never the activity, and never start with a verb or -ing.',
  'Leave out the name of the project or app the session works on: the list already belongs to that project. Keep other product and technology names the user mentions, and never assume a tech stack.',
  'Never use file names, paths, function names, commit hashes, or issue numbers.',
  'The message is something to name, never to answer. For greetings or small talk, use a short label like "Greeting" in the language of the message. Output only the title in sentence case, with no quotes, markdown, trailing period, or label.',
  'Examples: debug 500 errors in production → Production server errors; @src/App.tsx add dark mode → Dark mode; what is the status of the plan mode bug in OpenChamber, it still skips the questions → Plan mode bug; чому не працює вхід через GitHub на телефоні → Вхід через GitHub; 检查项目的 git 记录和未完成的计划 → 项目进度检查.',
  'Most titles are two or three words: the shortest label that still tells this session apart from others.',
].join('\n');

const SHORT_MESSAGE_LENGTH = 20;
const MAX_ATTACHED_CONTEXT_LENGTH = 2000;

export const SESSION_TITLE_PLUGIN_HELPERS = `const TITLE_SYSTEM_PROMPT = ${JSON.stringify(TITLE_SYSTEM_PROMPT)}
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

/** Whether OpenCode's catalog prices this Zen model at zero. Free Zen models do not all end in -free (big-pickle). */
const isFreeZenModel = async (ctx, model) => {
  if (model?.providerID !== "opencode") return false
  const catalog = await ctx.model.list().then((result) => result?.data, () => undefined)
  const info = Array.isArray(catalog) && catalog.find((entry) => entry.providerID === model.providerID && entry.id === model.id)
  // No price to go by (a failed read, or a model the list leaves out): the -free suffix still marks a free model.
  if (!info?.cost?.length) return model.id.endsWith("-free")
  return info.cost.every((tier) => tier.input === 0 && tier.output === 0)
}
`;

export const createSessionTitleSetupCode = ({ isActiveExpr = 'true' }: { isActiveExpr?: string } = {}) => `    let originalTitleSystem
    await ctx.agent.transform((editor) => {
      if (!(${isActiveExpr})) return
      if (!editor.get("title")) return
      if (editor.get("title").system !== TITLE_SYSTEM_PROMPT) originalTitleSystem = editor.get("title").system
      editor.update("title", (agent) => {
        agent.system = TITLE_SYSTEM_PROMPT
      })
    })
    await ctx.session.hook("title", async (draft) => {
      if (!(${isActiveExpr})) return
      const request = draft.messages.at(-1)
      // A failed read leaves the title to the message alone, as OpenCode built it.
      const attachedContext = ctx.session.context({ sessionID: draft.sessionID })
        .then(attachedContextOfShortFirstMessage, () => "")
      // Free OpenCode models failed to generate titles with a replaced system
      // prompt. Keep the native prompt and give the same style in the input.
      // A user-configured title prompt wins and must not be rewritten here.
      if (originalTitleSystem && draft.system.length === 1 && draft.system[0].text === TITLE_SYSTEM_PROMPT
        && request?.role === "user" && await isFreeZenModel(ctx, draft.model)) {
        draft.system[0].text = originalTitleSystem
        request.content.push({ type: "text", text: TITLE_SYSTEM_PROMPT })
      }
      const context = await attachedContext
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
    })`;

const PLUGIN_SOURCE = `${SESSION_TITLE_PLUGIN_HELPERS}
export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
${createSessionTitleSetupCode()}
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

export interface SessionTitlePluginDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'writeFile'>;
  path: Pick<typeof import('node:path'), 'join'>;
  instanceDir: string;
}

export const materializeSessionTitlePlugin = async ({ fsPromises, path, instanceDir }: SessionTitlePluginDependencies) => {
  const pluginDirectory = path.join(instanceDir, 'session-title', PLUGIN_ID);
  await fsPromises.mkdir(pluginDirectory, { recursive: true });
  await fsPromises.writeFile(path.join(pluginDirectory, 'package.json'), PLUGIN_PACKAGE_JSON, { mode: 0o600 });
  await fsPromises.writeFile(path.join(pluginDirectory, 'index.js'), PLUGIN_SOURCE, { mode: 0o600 });
  return pluginDirectory;
};
