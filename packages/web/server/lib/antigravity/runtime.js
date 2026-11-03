import { AGY_COMMAND, ANTIGRAVITY_CLI_INSTALL_URL, AntigravityError, buildChildEnv, buildModelsArgs, buildRunArgs, buildVersionArgs, classifyFailure, isValidArgumentToken, outcomeFromEnvelope, parseEnvelope, parseModelsOutput, parseTimeoutMs, redactSecrets, resolveBinary } from './cli.js';
import { ANTIGRAVITY_SKILL } from './skill.js';
import { createCallbackAddress } from '../agent-tool/callback-address.js';
import { isEnterpriseMode } from '../enterprise-mode.js';

const PLUGIN_ID = 'openchamber-antigravity';
const STATUS_CACHE_TTL_MS = 30_000;
const MODELS_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 20_000;
const KILL_GRACE_MS = 2_000;

const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: PLUGIN_ID,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

/**
 * Tool description. It is the only place the model learns when delegating is
 * worth it and who reviews the result, and it is paid for on every request, so
 * it stays to what changes the decision.
 */
const TOOL_DESCRIPTION = [
  'Delegate a well-scoped task to Antigravity (the Google Antigravity CLI, `agy`).',
  'Best for bulk work, scaffolding, tests, research, or a second model\'s opinion on a change.',
  'Antigravity works in the session\'s project with its own tools and permissions; in headless mode a tool it cannot get approval for is denied, and the result says so.',
  'You must review the files it changed and verify the result before reporting it as done.',
  'Call it again with `conversation` to continue a previous Antigravity conversation, or omit it to continue the one this session started.',
].join(' ');

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The task, scoped and specific. State what "done" looks like.' },
    model: { type: 'string', description: 'Antigravity model id (from `agy models`). Defaults to the model chosen in Settings.' },
    conversation: { type: 'string', description: 'Antigravity conversation id from an earlier result. Omit to continue this session\'s conversation.' },
    timeout: { type: 'string', description: 'Time limit such as "5m" or "300s". Default 15 minutes, at most 1 hour.' },
  },
  required: ['prompt'],
  additionalProperties: false,
};

/** The OpenCode plugin source. Injected values are JSON so no escaping is guessed. */
const createPluginSource = ({ toolDescription, inputSchema, skill }) => `const CALLBACK_URL = process.env.OPENCHAMBER_ANTIGRAVITY_URL
const CALLBACK_TOKEN = process.env.OPENCHAMBER_ANTIGRAVITY_TOKEN
// One Antigravity conversation per OpenCode session, so a follow-up that does
// not name an id still lands in the same context. Cleared by a plugin reload;
// the result always carries the id, which is the durable way to resume.
const conversations = new Map()

// The callback carries the per-child token over plain HTTP. With a proxy in
// the child's environment, fetch would hand a non-loopback callback, token
// included, to that proxy. The exemption is added inside the child because
// only there is the final NO_PROXY, merged from the shell and server
// environments, visible.
const exemptCallbackFromProxy = () => {
  if (!CALLBACK_URL || !URL.canParse(CALLBACK_URL)) return
  const host = new URL(CALLBACK_URL).hostname.replace(/^\\[|\\]$/g, "")
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] || "").split(",").map((entry) => entry.trim()).filter(Boolean)
    if (!entries.includes(host)) process.env[key] = [...entries, host].join(",")
  }
}

const errorText = (code, message, details) => {
  const lines = ["AGY_ERROR [" + code + "]", message]
  if (details && Object.keys(details).length) lines.push("", JSON.stringify(details, null, 2))
  lines.push("", "Tell the user what failed. Do not retry blindly; fix the cause first.")
  return lines.join("\\n")
}

const formatResult = (data) => {
  const seconds = Math.max(1, Math.round((data.durationMs || 0) / 1000))
  const facts = [data.model || "Antigravity", seconds + "s"].filter(Boolean).join(" · ")
  const conversation = data.conversationId ? "\\n\\nconversation: " + data.conversationId : ""
  return "## Antigravity result\\n" + facts + "\\n\\n" + data.response + conversation
}

export default {
  id: "openchamber.antigravity",
  async setup(ctx) {
    exemptCallbackFromProxy()
    const call = async (body, signal) => {
      if (!CALLBACK_URL || !CALLBACK_TOKEN) throw new Error("The OpenChamber Antigravity service is unavailable.")
      const response = await fetch(CALLBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + CALLBACK_TOKEN },
        body: JSON.stringify(body),
        signal,
        // A delegated turn may run for the CLI's whole timeout; Bun's fetch
        // would otherwise end a request with no response after about six
        // minutes and cancel work that is still going.
        timeout: false,
      })
      const payload = await response.json().catch(() => null)
      if (!payload) throw new Error("The OpenChamber Antigravity service returned no answer.")
      return payload
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "agy",
        description: ${JSON.stringify(toolDescription)},
        input: ${JSON.stringify(inputSchema, null, 6)},
        options: { codemode: false },
        execute: async (input, context) => {
          const sessionID = typeof context?.sessionID === "string" ? context.sessionID : undefined
          const conversation = input.conversation || (sessionID ? conversations.get(sessionID) : undefined)
          try {
            const payload = await call({
              prompt: input.prompt,
              model: input.model,
              conversation,
              timeout: input.timeout,
              sessionID,
            }, context?.signal)
            if (!payload.ok) {
              return { content: errorText(payload.error?.code || "AGY_FAILED", payload.error?.message || "Antigravity failed.", payload.error?.details), metadata: { error: true, code: payload.error?.code } }
            }
            if (sessionID && payload.data?.conversationId) conversations.set(sessionID, payload.data.conversationId)
            return {
              content: formatResult(payload.data),
              metadata: {
                model: payload.data.model,
                conversationId: payload.data.conversationId,
                durationMs: payload.data.durationMs,
              },
            }
          } catch (error) {
            if (context?.signal?.aborted) return { content: "The Antigravity task was cancelled." }
            return { content: errorText("AGY_FAILED", error instanceof Error ? error.message : String(error)) }
          }
        },
      })
    })

    if (ctx.command?.transform) {
      // A host whose command contract differs must not take the tool down
      // with it: the tool is the feature, /agy is a shortcut.
      try {
        await ctx.command.transform((editor) => {
          editor.add({
            name: "agy",
            description: "Delegate a task to Antigravity (agy) and have the agent report what it changed",
            execute: async ({ sessionID, prompt, delivery }) => {
              const task = typeof prompt?.text === "string" ? prompt.text.trim() : ""
              if (!task) return
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: "Use the agy tool to complete this task, then review the files it changed and report the outcome:\\n\\n" + task,
                delivery,
              })
            },
          })
        })
      } catch (error) {
        console.warn("[openchamber-antigravity] /agy command registration skipped:", error instanceof Error ? error.message : String(error))
      }
    }

    if (ctx.skill?.transform) {
      // The skill teaches the agent when delegating is worth it and how to
      // resume. A host without the skill API keeps the tool.
      try {
        const skill = ${JSON.stringify(skill)}
        await ctx.skill.transform((editor) => {
          const existing = typeof editor.get === "function" ? editor.get(skill.id) : undefined
          if (!existing) {
            editor.add(skill)
            return
          }
          if (existing.content === skill.content && existing.description === skill.description && existing.path === skill.path) return
          editor.update(skill.id, (draft) => {
            draft.name = skill.name
            draft.description = skill.description
            draft.path = skill.path
            draft.content = skill.content
          })
        })
      } catch (error) {
        console.warn("[openchamber-antigravity] skill registration skipped:", error instanceof Error ? error.message : String(error))
      }
    }
  },
}
`;

/**
 * Create the Antigravity delegation runtime.
 *
 * The CLI runs here, beside the OpenChamber server, so the tool works for web,
 * desktop and hosted mobile clients that reach this server. The managed plugin
 * it writes is only a thin caller; every decision that matters (enabled,
 * enterprise mode, binary, timeout, process tree) is made in this process.
 */
export const createAntigravityRuntime = (dependencies) => {
  const {
    crypto,
    fs,
    fsPromises,
    path,
    spawn,
    instanceDir,
    readSettings,
    resolveSessionDirectory,
    getActivePort,
    getActiveHost = () => null,
    getUiAuthController = () => null,
    isExternalOpenCode = () => false,
  } = dependencies;

  const pluginDirectory = path.join(instanceDir, 'antigravity', PLUGIN_ID);
  const pluginPath = path.join(pluginDirectory, 'index.js');
  const pluginManifestPath = path.join(pluginDirectory, 'package.json');
  const { callbackHost, isSameMachineAddress } = createCallbackAddress(getActiveHost);
  let activeToken = null;
  let statusCache = null;
  let statusInFlight = null;

  const readRuntimeSettings = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    return {
      enabled: settings?.antigravityDelegationEnabled === true,
      model: typeof settings?.antigravityDelegationModel === 'string' ? settings.antigravityDelegationModel.trim() : '',
      skipPermissions: settings?.antigravityDelegationSkipPermissions === true,
    };
  };

  const binary = () => resolveBinary({
    isFile: (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  });

  /** Spawn the CLI and collect its envelopes; the caller owns the result. */
  const runProcess = ({ args, cwd, timeoutMs, env, signal }) => new Promise((resolve, reject) => {
    const binaryPath = binary();
    if (!binaryPath) {
      reject(new AntigravityError(
        `The Antigravity CLI (\`${AGY_COMMAND}\`) is not installed on this machine. Install it from ${ANTIGRAVITY_CLI_INSTALL_URL} and run \`${AGY_COMMAND}\` once to sign in.`,
        'AGY_NOT_FOUND',
      ));
      return;
    }
    const child = spawn(binaryPath, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A separate process group lets a cancellation end the commands the CLI
      // started, not only the CLI itself.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };

    const killTree = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {
          try { child.kill(); } catch { /* already gone */ }
        });
        return;
      }
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      const hard = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }, KILL_GRACE_MS);
      hard.unref?.();
    };

    const onAbort = () => {
      aborted = true;
      killTree();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs + 2_000);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_STDOUT_BYTES) {
        stdout = stdout.slice(0, MAX_STDOUT_BYTES);
        killTree();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
    });
    child.once('error', (error) => finish(reject, new AntigravityError(
      error?.code === 'ENOENT'
        ? `The Antigravity CLI (\`${AGY_COMMAND}\`) could not be started.`
        : `Antigravity could not start: ${error instanceof Error ? error.message : String(error)}`,
      error?.code === 'ENOENT' ? 'AGY_NOT_FOUND' : 'AGY_FAILED',
    )));
    child.once('close', (exitCode) => {
      if (aborted) {
        finish(reject, new AntigravityError('The Antigravity task was cancelled.', 'CANCELLED'));
        return;
      }
      finish(resolve, { stdout, stderr, exitCode: typeof exitCode === 'number' ? exitCode : 1, timedOut });
    });
  });

  const listModels = async ({ timeoutMs = MODELS_TIMEOUT_MS } = {}) => {
    const result = await runProcess({
      args: buildModelsArgs(),
      cwd: instanceDir,
      timeoutMs,
      env: buildChildEnv(),
    });
    if (result.timedOut) throw new AntigravityError('Listing Antigravity models timed out.', 'TIMEOUT');
    const models = parseModelsOutput(result.stdout);
    if (models.length === 0) {
      const message = redactSecrets(result.stderr.trim() || result.stdout.trim() || 'Antigravity listed no models.');
      const code = result.exitCode === 0 ? 'MODELS_EMPTY' : 'AGY_FAILED';
      throw new AntigravityError(message, code, { exitCode: result.exitCode });
    }
    return models;
  };

  /** Installed version, or null when the CLI is absent. */
  const readVersion = async () => {
    const result = await runProcess({
      args: buildVersionArgs(),
      cwd: instanceDir,
      timeoutMs: VERSION_TIMEOUT_MS,
      env: buildChildEnv(),
    }).catch(() => null);
    if (!result || result.exitCode !== 0) return null;
    const match = result.stdout.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : null;
  };

  /**
   * What the Settings page shows. Cached briefly: opening the page and a
   * provider refresh should not each spawn two CLI processes, and a user who
   * just installed the CLI gets a fresh answer within half a minute.
   */
  const status = async ({ force = false } = {}) => {
    // Enterprise mode keeps conversation content inside the OpenCode
    // providers. Even listing models reaches Google with the user's own
    // sign-in, so the CLI is not started at all.
    const managed = !isExternalOpenCode();
    if (isEnterpriseMode()) {
      return { installed: false, binaryPath: null, version: null, models: [], error: null, blocked: true, managed, checkedAt: Date.now() };
    }
    if (!force && statusCache && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) return { ...statusCache.value, managed };
    if (statusInFlight) return statusInFlight;
    statusInFlight = (async () => {
      const binaryPath = binary();
      const checkedAt = Date.now();
      if (!binaryPath) {
        return { installed: false, binaryPath: null, version: null, models: [], error: null, blocked: false, managed, checkedAt };
      }
      const version = await readVersion();
      let models = [];
      let error = null;
      try {
        models = await listModels();
      } catch (caught) {
        error = {
          code: caught instanceof AntigravityError ? caught.code : 'AGY_FAILED',
          message: redactSecrets(caught instanceof Error ? caught.message : String(caught)),
        };
      }
      return { installed: true, binaryPath, version, models, error, blocked: false, managed, checkedAt };
    })()
      .then((value) => {
        statusCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        statusInFlight = null;
      });
    return statusInFlight;
  };

  /**
   * Write the plugin for the current settings and return its directory, or
   * null while delegation is off, the administrator forbids model services, or
   * the CLI is absent. OpenCode reloads the directory it already has
   * configured, so a toggle needs no restart.
   */
  const materializePlugin = async () => {
    const settings = await readRuntimeSettings();
    // An external OpenCode server is not launched by OpenChamber, so there is
    // no managed config file to list the plugin in.
    if (!settings.enabled || isEnterpriseMode() || isExternalOpenCode() || !binary()) return null;
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(pluginManifestPath, PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(
      pluginPath,
      createPluginSource({ toolDescription: TOOL_DESCRIPTION, inputSchema: TOOL_INPUT_SCHEMA, skill: ANTIGRAVITY_SKILL }),
      { mode: 0o600 },
    );
    return pluginDirectory;
  };

  /**
   * The callback URL and a fresh per-child token.
   *
   * Present even while delegation is off: the user can turn it on later in a
   * running OpenCode, and the managed config rewrite picks the plugin up
   * without a restart. The route re-checks the setting and enterprise mode on
   * every call, so an unused token grants nothing.
   */
  const createChildEnv = async () => {
    const port = getActivePort();
    if (!Number.isInteger(port) || port <= 0) return {};
    activeToken = crypto.randomBytes(32).toString('base64url');
    return {
      OPENCHAMBER_ANTIGRAVITY_URL: `http://${callbackHost()}:${port}/api/antigravity/run`,
      OPENCHAMBER_ANTIGRAVITY_TOKEN: activeToken,
    };
  };

  const authorize = (req) => {
    if (!activeToken || !isSameMachineAddress(req.socket?.remoteAddress)) return false;
    const header = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
    if (!header.startsWith('Bearer ')) return false;
    const provided = Buffer.from(header.slice(7));
    const expected = Buffer.from(activeToken);
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  };

  /**
   * One delegated task. The session's directory is the only working directory
   * a task gets; a model cannot name a path outside it.
   */
  const run = async (payload = {}, { signal } = {}) => {
    if (isEnterpriseMode()) {
      throw new AntigravityError('Enterprise mode does not allow adding a model provider this way.', 'ENTERPRISE_MODE');
    }
    if (isExternalOpenCode()) {
      throw new AntigravityError(
        'Antigravity delegation needs OpenChamber to start OpenCode. This server is connected to an external OpenCode.',
        'EXTERNAL_OPENCODE',
      );
    }
    const settings = await readRuntimeSettings();
    if (!settings.enabled) {
      throw new AntigravityError('Antigravity delegation is switched off in Settings.', 'DISABLED');
    }
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) throw new AntigravityError('A prompt is required.', 'INVALID_ARGUMENT');
    const timeoutMs = parseTimeoutMs(payload.timeout);
    const model = typeof payload.model === 'string' && payload.model.trim()
      ? payload.model.trim()
      : settings.model;
    const conversationId = typeof payload.conversation === 'string' && payload.conversation.trim()
      ? payload.conversation.trim()
      : null;
    // Both reach argv as values. Only the shapes Antigravity itself produces
    // are accepted, so a model cannot turn one into another flag.
    if (model && !isValidArgumentToken(model)) {
      throw new AntigravityError('That Antigravity model id is not valid.', 'INVALID_ARGUMENT', { model });
    }
    if (conversationId && !isValidArgumentToken(conversationId)) {
      throw new AntigravityError('That Antigravity conversation id is not valid.', 'INVALID_ARGUMENT');
    }
    const sessionID = typeof payload.sessionID === 'string' ? payload.sessionID : '';
    const directory = sessionID && typeof resolveSessionDirectory === 'function'
      ? await Promise.resolve(resolveSessionDirectory(sessionID)).catch(() => null)
      : null;
    if (!directory) {
      throw new AntigravityError('The session directory could not be resolved, so Antigravity has nowhere to work.', 'NO_DIRECTORY');
    }

    const startedAt = Date.now();
    const result = await runProcess({
      args: buildRunArgs({ model, prompt, timeoutMs, conversationId, skipPermissions: settings.skipPermissions }),
      cwd: directory,
      timeoutMs,
      env: buildChildEnv(),
      signal,
    });
    if (result.timedOut) {
      throw new AntigravityError(
        `Antigravity did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`,
        'TIMEOUT',
        { durationMs: Date.now() - startedAt, model },
      );
    }
    const envelope = parseEnvelope(result.stdout);
    if (!envelope) {
      const message = redactSecrets(result.stderr.trim() || `Antigravity exited with code ${result.exitCode} and no result.`);
      throw new AntigravityError(message, classifyFailure({ message, exitCode: result.exitCode }), {
        exitCode: result.exitCode,
        stderr: redactSecrets(result.stderr).slice(-2000),
        durationMs: Date.now() - startedAt,
        model,
      });
    }
    return outcomeFromEnvelope({
      envelope,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      model,
    });
  };

  const registerRoutes = (app, express) => {
    // The Settings page reads the CLI's own catalog; this is the only view of
    // it, so a stale reading is refreshed on request. Registered before the
    // OpenCode proxy and gated by the UI auth controller, like the other
    // OpenChamber API routes that answer per-user state.
    app.get('/api/antigravity/status', async (req, res, next) => {
      const respond = async () => {
        try {
          return res.json(await status({ force: req.query?.refresh === '1' }));
        } catch (error) {
          return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
        }
      };
      const uiAuth = getUiAuthController();
      if (uiAuth && typeof uiAuth.requireAuth === 'function') {
        try {
          await uiAuth.requireAuth(req, res, respond);
        } catch (error) {
          next(error);
        }
        return;
      }
      await respond();
    });

    // Called by the managed plugin only. The token is minted per managed child
    // and answers only from this machine, so a page script cannot run the CLI.
    app.post('/api/antigravity/run', express.json({ limit: '256kb' }), async (req, res) => {
      if (!authorize(req)) {
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'The OpenChamber Antigravity service refused this call.' } });
      }
      const controller = new AbortController();
      const abortOnDisconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once('aborted', abortOnDisconnect);
      res.once('close', abortOnDisconnect);
      try {
        const data = await run(req.body, { signal: controller.signal });
        return res.json({ ok: true, data });
      } catch (error) {
        return res.json({
          ok: false,
          error: {
            code: error instanceof AntigravityError ? error.code : 'AGY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            details: error instanceof AntigravityError ? error.details : undefined,
          },
        });
      } finally {
        req.off('aborted', abortOnDisconnect);
        res.off('close', abortOnDisconnect);
      }
    });
  };

  return {
    pluginDirectory,
    materializePlugin,
    createChildEnv,
    status,
    run,
    registerRoutes,
  };
};
