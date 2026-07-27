/**
 * In-process Claude Agent SDK MCP adapter for the OpenChamber control tool.
 * Shares the same action allowlist + executeAction path as the OpenCode plugin.
 */

import { z } from 'zod';
import {
  OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS,
  OPENCHAMBER_AGENT_TOOL_ACTIONS,
} from '../openchamber-control/actions.js';

const TOOL_SCHEMA_VERSION = 1;
const AGENT_TOOL_ACTION_TITLES = Object.fromEntries(
  OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS.map(({ action, title }) => [action, title]),
);

const TOOL_DESCRIPTION = "Control OpenChamber projects, sessions, and scheduled tasks on the user's behalf. Sessions and scheduled tasks you create are for the user to follow and interact with; never use this tool to delegate parts of your own current task. Use one action per call. Scope with projectId or directory; omit both to use the current session directory. Session dispatches return immediately by default and you receive no notification when a dispatched session finishes, so never promise to report back on it; the user follows it in OpenChamber; a dispatched session needs no follow-up from you. If the user later asks how it went, use session.messages (add wait to block until it is idle, lastAssistant for just the final answer) — session.send always sends a NEW prompt and never just waits. Set wait only when the user asks or the next step requires the completed result. Session and worktree deletion are unavailable. For Claude Code models use provider/model as claude-code/<modelRef> (for example claude-code/haiku).";

const PARAMETER_SCHEMA = z.object({
  projectId: z.string().optional().describe('Configured project ID; do not combine with directory'),
  directory: z.string().optional().describe('Absolute checkout or session directory; defaults to the current session directory'),
  sessionId: z.string().optional(),
  messageId: z.string().optional().describe('Optional fork boundary message ID'),
  taskId: z.string().optional(),
  title: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional().describe('Model in provider/model format. Claude Code uses claude-code/<modelRef>. When the user names no model: for session.create pick a suitable one from models.list favorites or recents (omit if there are none); for send and fork omit it — the session reuses its previous model'),
  agent: z.string().optional().describe('OpenCode agent name; new sessions default to the build agent and existing sessions keep their previous one. Set only when the user explicitly requests a different agent'),
  variant: z.string().optional().describe('Model variant or Claude effort; use only when the user explicitly requests it'),
  worktree: z.string().optional().describe('New worktree name for session.create. Omit by default; use only when the user explicitly asks for an isolated worktree. Uncommitted changes do not carry over into a new worktree'),
  branch: z.string().optional().describe('Branch name for the new worktree'),
  startRef: z.string().optional().describe('Git ref used to create the new worktree'),
  setUpstream: z.boolean().optional().describe('Make the new worktree branch track its upstream'),
  goal: z.boolean().optional().describe('Run the dispatched prompt in Goal Mode; use only when the user explicitly requests it'),
  goalTokenBudget: z.number().int().min(1000).max(100_000_000).optional().describe('Goal token budget; requires goal'),
  wait: z.boolean().optional().describe('Wait for current session activity to become idle. Omit by default; use only when the user asks or the next step requires the completed result'),
  timeout: z.number().int().min(1).max(86_400).optional().describe('Wait timeout in seconds (default 600); requires wait'),
  lastAssistant: z.boolean().optional().describe('Return the last assistant text; create/send/fork require wait'),
  limit: z.number().int().min(1).optional().describe('Maximum sessions or messages to return (default 10)'),
  all: z.boolean().optional().describe('Include archived sessions or all messages, depending on the action'),
  last: z.boolean().optional().describe('Return only the last matching session message'),
  withStatus: z.boolean().optional().describe('Include authoritative status in session.list'),
  role: z.enum(['all', 'user', 'assistant']).optional().describe('Message role filter'),
  name: z.string().optional(),
  daily: z.string().optional().describe('Daily run time in HH:mm format'),
  weekly: z.string().optional().describe('Comma-separated weekdays; 0=Sunday and 6=Saturday'),
  once: z.string().optional().describe('One-time run date in YYYY-MM-DD format'),
  time: z.string().optional().describe('Weekly or one-time run time in HH:mm format'),
  cron: z.string().optional().describe('Cron expression'),
  timezone: z.string().optional().describe('IANA timezone'),
  disabled: z.boolean().optional().describe('true disables and false enables; required for schedule.toggle'),
}).strict();

const createResult = ({ ok, action, data, error, exitCode }) => ({
  schemaVersion: TOOL_SCHEMA_VERSION,
  ok,
  action: action || 'unknown',
  ...(data !== undefined ? { data } : {}),
  ...(error ? { error } : {}),
  ...(Number.isInteger(exitCode) ? { exitCode } : {}),
});

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * @param {object} dependencies
 * @param {(action: string, input: object, contextDirectory: string | null, options?: object) => Promise<object>} dependencies.executeAction
 * @param {() => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>} [dependencies.loadSdk]
 * @returns {{
 *   isEnabled: () => Promise<boolean>,
 *   createMcpServers: (options?: { contextDirectory?: string | null, signal?: AbortSignal }) => Promise<Record<string, unknown> | null>,
 * }}
 */
export function createClaudeOpenChamberMcpAdapter(dependencies) {
  const {
    executeAction,
    loadSdk,
    isEnabled = async () => true,
  } = dependencies;

  const resolveSdk = async () => {
    if (typeof loadSdk === 'function') return loadSdk();
    return import('@anthropic-ai/claude-agent-sdk');
  };

  const runAction = async (args, options = {}) => {
    const action = asNonEmptyString(args?.action);
    if (!action || !OPENCHAMBER_AGENT_TOOL_ACTIONS.includes(action)) {
      return createResult({
        ok: false,
        action,
        error: { message: `Unsupported OpenChamber action: ${action || 'missing'}`, kind: 'usage' },
      });
    }
    if (typeof executeAction !== 'function') {
      return createResult({
        ok: false,
        action,
        error: { message: 'OpenChamber control service is unavailable', kind: 'runtime' },
      });
    }

    const parameters = args?.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters)
      ? args.parameters
      : {};
    const input = { ...parameters, action };
    const contextDirectory = asNonEmptyString(options.contextDirectory);

    try {
      const data = await executeAction(action, input, contextDirectory, {
        signal: options.signal,
      });
      return createResult({ ok: true, action, data });
    } catch (error) {
      return createResult({
        ok: false,
        action,
        ...(error?.partial === true ? {
          data: {
            partial: true,
            partialAction: error.partialAction,
            sessionId: error.sessionId,
            directory: error.directory,
          },
        } : {}),
        error: {
          message: error instanceof Error ? error.message : String(error),
          kind: Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 499 ? 'usage' : 'runtime',
        },
      });
    }
  };

  const createMcpServers = async (options = {}) => {
    if (!(await isEnabled())) return null;
    const sdk = await resolveSdk();
    if (typeof sdk?.createSdkMcpServer !== 'function' || typeof sdk?.tool !== 'function') {
      return null;
    }

    const actionEnum = z.enum(OPENCHAMBER_AGENT_TOOL_ACTIONS);
    const server = sdk.createSdkMcpServer({
      name: 'openchamber',
      version: '1.0.0',
      alwaysLoad: true,
      tools: [
        sdk.tool(
          'openchamber',
          TOOL_DESCRIPTION,
          {
            action: actionEnum.describe(
              `OpenChamber action to perform. ${OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS
                .map(({ action, description }) => `${action}: ${description}`)
                .join(' ')}`,
            ),
            parameters: PARAMETER_SCHEMA.optional().describe(
              'Inputs for the action; use an empty object when none are needed',
            ),
          },
          async (args) => {
            const result = await runAction(args, {
              contextDirectory: options.contextDirectory,
              signal: options.signal,
            });
            const title = Object.hasOwn(AGENT_TOOL_ACTION_TITLES, result.action)
              ? AGENT_TOOL_ACTION_TITLES[result.action]
              : result.action;
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result),
              }],
              // Surface a short title for hosts that render tool metadata.
              _meta: {
                openchamber: {
                  schemaVersion: TOOL_SCHEMA_VERSION,
                  action: result.action,
                  description: title,
                  ok: result.ok === true,
                },
              },
            };
          },
        ),
      ],
    });

    return { openchamber: server };
  };

  return {
    isEnabled,
    createMcpServers,
    runAction,
  };
}
