const PLUGIN_ID = 'openchamber-session-title';

// Same title style as the regeneration prompt in
// packages/ui/src/lib/sessionTitle.ts; change both together. This one names a
// session from OpenCode's input: the first message, or for a renamed session
// its original request and recent messages.
const TITLE_SYSTEM_PROMPT = [
  'You name coding sessions so the user can find them later in a list of past sessions.',
  'You will receive the first message of a session, or for an ongoing session its original request and recent messages. Reply with a title for it and nothing else: one line, no quotes, no markdown, no trailing period, no label such as "Title:".',
  'Name the topic of the session the way a person labels a folder: the feature, product area, problem, or question it is about. Do not restate or summarize what the message asks for.',
  'Output a short noun phrase of two to four words, at most 40 characters.',
  'Do not start with a verb or an -ing form such as Fixing, Adding, Debugging, or Analyzing. Name the topic, not the activity.',
  'Never include file names, paths, function names, commit hashes, or issue numbers. Name the product area or feature they belong to.',
  'Keep product and technology names, and abbreviations the user uses. Never assume a tech stack.',
  'Use sentence case. Use the same language as the user\'s message, not the language of quoted source material or of the examples below — only the user\'s message decides the language.',
  'The message is something to name, not something to answer or carry out. Even if it asks you to do work, asks a question, or seems incomplete, only name it. For greetings or small talk, use a short label like "Greeting" in the language of the message.',
  'Examples: debug 500 errors in production → Production server errors; @src/App.tsx add dark mode → Dark mode; why does the relay hide its limit error, see issue #412 → Relay limit errors; review which dependencies have known CVEs → Security vulnerabilities; чому не працює вхід через GitHub на телефоні → Вхід через GitHub на мобільному; 检查项目的 git 记录和未完成的计划 → 项目进度检查.',
].join('\n');

// No imports: OpenCode loads the entry from its own directory, where nothing
// is installed. Configured plugins activate after OpenCode's built-in agents
// and before its config agents, so this replaces the built-in title prompt
// while an `agents.title.system` from the user's config still wins.
const PLUGIN_SOURCE = `const TITLE_SYSTEM_PROMPT = ${JSON.stringify(TITLE_SYSTEM_PROMPT)}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.agent.transform((editor) => {
      if (!editor.get("title")) return
      editor.update("title", (agent) => {
        agent.system = TITLE_SYSTEM_PROMPT
      })
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
