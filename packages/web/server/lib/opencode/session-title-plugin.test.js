import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { materializeSessionTitlePlugin } from './session-title-plugin.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

/** Load the written plugin and register it against a fake plugin context. */
const loadPlugin = async (sessionContext = async () => []) => {
  const instanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-session-title-'));
  temporaryDirectories.push(instanceDir);
  const directory = await materializeSessionTitlePlugin({ fsPromises: fs, path, instanceDir });
  const { default: plugin } = await import(pathToFileURL(path.join(directory, 'index.js')).href);
  const transforms = [];
  const hooks = new Map();
  await plugin.setup({
    agent: { transform: async (callback) => { transforms.push(callback); } },
    session: {
      hook: async (name, callback) => { hooks.set(name, callback); },
      context: sessionContext,
    },
  });
  return { directory, plugin, transforms, hooks };
};

/** Load the written plugin and run its agent transform over the given agents. */
const runTransform = async (agents) => {
  const { directory, plugin, transforms } = await loadPlugin();
  const editor = {
    get: (id) => agents.get(id),
    update: (id, update) => update(agents.get(id)),
  };
  for (const transform of transforms) transform(editor);
  return { directory, plugin };
};

describe('session title plugin', () => {
  it('is a loadable plugin directory', async () => {
    const { directory, plugin } = await runTransform(new Map());

    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    expect(manifest.exports).toEqual({ '.': './index.js' });
    expect(plugin.id).toBe('openchamber-session-title');
  });

  it('replaces the title agent prompt and leaves other agents alone', async () => {
    const title = { id: 'title', system: 'OpenCode title prompt' };
    const build = { id: 'build', system: 'Build prompt' };

    await runTransform(new Map([['title', title], ['build', build]]));

    expect(title.system).toContain('labels a folder');
    expect(title.system).toContain('Most titles are two or three words');
    expect(title.system).toContain('Leave out the name of the project');
    expect(build.system).toBe('Build prompt');
  });

  it('keeps every title example within the four-word limit', async () => {
    const title = { id: 'title', system: 'OpenCode title prompt' };

    await runTransform(new Map([['title', title]]));

    // A weak model copies the example shape, so every example must stay inside
    // the limit the prompt asks for.
    const examples = title.system.split('\n').find((line) => line.startsWith('Examples: ')).slice('Examples: '.length);
    for (const example of examples.split('; ')) {
      const output = example.split(' → ')[1];
      expect(output.split(/\s+/).length).toBeLessThanOrEqual(4);
    }
  });

  it('pins the title language to the user message despite English-dominated examples', async () => {
    const title = { id: 'title', system: 'OpenCode title prompt' };

    await runTransform(new Map([['title', title]]));

    expect(title.system).toContain('Only the user\'s message decides the language');
    // The examples are mostly English (one Ukrainian); a weak model imitates the
    // example language and drifts on a Chinese first message, so the prompt pins
    // the output language and carries an example in another language.
    expect(title.system).toContain('检查项目的 git 记录和未完成的计划 → 项目进度检查');
  });

  it('does nothing when there is no title agent', async () => {
    const agents = new Map();

    await runTransform(agents);

    expect(agents.size).toBe(0);
  });

  describe('title hook', () => {
    const titleDraft = (text) => ({
      sessionID: 'ses_1',
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: `<message>\n${text}\n</message>` }] }],
      options: {},
    });
    const runHook = async (messages, text) => {
      const { hooks } = await loadPlugin(async ({ sessionID }) => {
        expect(sessionID).toBe('ses_1');
        return messages;
      });
      const draft = titleDraft(text);
      await hooks.get('title')(draft);
      return draft;
    };
    const comment = { type: 'synthetic', text: 'Comment on src/relay.ts:12\nThe reconnect backoff never resets' };

    it('adds the context attached to an empty first message', async () => {
      const draft = await runHook([comment, { type: 'user', text: '' }], '');

      expect(draft.messages).toHaveLength(1);
      expect(draft.messages[0].role).toBe('user');
      expect(draft.messages[0].content[0].text).toBe('<message>\n\n</message>');
      expect(draft.messages[0].content[1].text).toContain('The reconnect backoff never resets');
      expect(draft.result).toBeUndefined();
    });

    it('adds the context attached to a very short first message', async () => {
      const draft = await runHook([comment, { type: 'user', text: 'fix this' }], 'fix this');

      expect(draft.messages[0].content[1].text).toContain('The reconnect backoff never resets');
    });

    it('leaves a first message that names the topic alone', async () => {
      const text = 'Why does the relay reconnect so slowly after sleep?';
      const draft = await runHook([comment, { type: 'user', text }], text);

      expect(draft.messages[0].content).toHaveLength(1);
    });

    it('ignores context sent with later messages', async () => {
      const draft = await runHook([{ type: 'user', text: '' }, comment, { type: 'user', text: '' }], '');

      expect(draft.messages[0].content).toHaveLength(1);
    });

    it('bounds the attached context', async () => {
      const draft = await runHook([{ type: 'synthetic', text: 'x'.repeat(10_000) }, { type: 'user', text: '' }], '');

      expect(draft.messages[0].content[1].text.length).toBeLessThan(2_200);
    });

    it('keeps the message-only title when the session context cannot be read', async () => {
      const { hooks } = await loadPlugin(async () => { throw new Error('offline'); });
      const draft = titleDraft('');

      await hooks.get('title')(draft);

      expect(draft.messages[0].content).toHaveLength(1);
    });
  });
});
