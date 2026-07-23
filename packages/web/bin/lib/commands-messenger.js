import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { requestJson as requestJsonDefault } from './cli-http.js';
import {
  intro,
  outro,
  logStatus,
  isJsonMode,
  isQuietMode,
  printJson,
} from '../cli-output.js';

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validateSendAt(value) {
  const text = normalizeString(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?$/.test(text)) {
    throw new TunnelCliError('--send-at must be a UTC ISO timestamp like 2026-03-01T09:00Z.', EXIT_CODE.USAGE_ERROR);
  }
  if (Date.parse(text.endsWith('Z') ? text : `${text}Z`) <= Date.now()) {
    throw new TunnelCliError('--send-at must be in the future.', EXIT_CODE.USAGE_ERROR);
  }
  return text.endsWith('Z') ? text : `${text}Z`;
}

function validateMessengerSendOptions(options = {}) {
  const prompt = normalizeString(options.prompt);
  if (!prompt) {
    throw new TunnelCliError('Missing --prompt <text>.', EXIT_CODE.USAGE_ERROR);
  }
  const channel = normalizeString(options.channel);
  const thread = normalizeString(options.thread);
  const session = normalizeString(options.session);
  const targets = [channel, thread, session].filter(Boolean);
  if (targets.length !== 1) {
    throw new TunnelCliError('Provide exactly one of --channel, --thread, or --session.', EXIT_CODE.USAGE_ERROR);
  }
  const model = normalizeString(options.model);
  if (model && !/^[^/]+\/.+$/.test(model)) {
    throw new TunnelCliError('--model must use provider/model format.', EXIT_CODE.USAGE_ERROR);
  }
  return {
    prompt,
    channel,
    thread,
    session,
    sendAt: validateSendAt(options.sendAt),
    notifyOnly: Boolean(options.notifyOnly),
    model,
    agent: normalizeString(options.agent),
  };
}

function buildMessengerSendRequest(options = {}) {
  const validated = validateMessengerSendOptions(options);
  const target = {
    ...(validated.session ? { session: validated.session } : {}),
    ...(validated.channel ? { channel: validated.channel } : {}),
    ...(validated.thread ? { channel: validated.thread } : {}),
  };
  if (validated.sendAt) {
    return {
      endpoint: '/api/messenger/agent/schedule',
      body: {
        ...target,
        text: validated.prompt,
        sendAt: validated.sendAt,
        notifyOnly: validated.notifyOnly,
        ...(validated.model ? { model: validated.model } : {}),
        ...(validated.agent ? { agent: validated.agent } : {}),
      },
    };
  }
  return {
    endpoint: '/api/messenger/agent/post',
    body: {
      ...target,
      text: validated.prompt,
      silent: validated.notifyOnly,
    },
  };
}

function createMessengerCommand({ requestJson = requestJsonDefault } = {}) {
  return async function messengerCommand(options, action = 'help') {
    if (action !== 'send') {
      throw new TunnelCliError("Unknown messenger subcommand. Use 'openchamber messenger send'.", EXIT_CODE.USAGE_ERROR);
    }
    const request = buildMessengerSendRequest(options);
    const { response, body } = await requestJson(options.port, request.endpoint, {
      method: 'POST',
      body: JSON.stringify(request.body),
      uiPassword: options.uiPassword,
      timeoutMs: 10000,
    });
    if (!response.ok || body?.ok === false) {
      throw new TunnelCliError(body?.error || `Messenger send failed with HTTP ${response.status}`, EXIT_CODE.GENERAL_ERROR);
    }

    if (isJsonMode(options)) {
      printJson({ ok: true, action: request.endpoint.endsWith('/schedule') ? 'scheduled' : 'sent', ...body });
      return body;
    }

    if (isQuietMode(options)) {
      const taskId = body?.task?.id;
      const url = body?.url ?? body?.target?.url ?? '';
      process.stdout.write(request.endpoint.endsWith('/schedule')
        ? `scheduled ${taskId ?? 'task'} ${url}\n`
        : `sent ${url}\n`);
      return body;
    }

    intro('Messenger send');
    if (request.endpoint.endsWith('/schedule')) {
      logStatus('success', `Scheduled ${body?.task?.id ?? 'messenger send'}`, body?.target?.url ?? '');
    } else {
      logStatus('success', 'Message sent', body?.url ?? body?.target?.url ?? '');
    }
    outro('done');
    return body;
  };
}

export {
  createMessengerCommand,
  validateMessengerSendOptions,
  buildMessengerSendRequest,
};
