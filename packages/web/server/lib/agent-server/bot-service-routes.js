import express from 'express';
import { isFunction } from '../shared/guards.js';
import { BOT_SERVICE_BYTES, BOT_SERVICE_INPUT_BYTES, BOT_SERVICE_OPERATIONS, BOT_SERVICE_ROUTE,
  botBoundaryError, botReplySchema, botRequestAssociation } from './bot-service-contract.js';

export { createBotExecutionServices } from '../bots/agent-execution.js';

/** Mount only in agent mode, after normal API authentication. No owner callback. */
export function registerBotServiceRoutes(app, { services, agentServer }) {
  if (agentServer === false) return;
  if (services?.agentServer !== true || !isFunction(services.execute)) throw new TypeError('Bot routes require agent execution services');
  app.use('/api/projects/:projectId/bots', (_req, res) => res.status(403).json({ code: 'BOT_OWNER_REQUIRED' }));
  const parse = express.json({ limit: BOT_SERVICE_INPUT_BYTES });
  app.post(`${BOT_SERVICE_ROUTE}/:operation`, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    parse(req, res, (error) => error ? res.status(400).json({ code: 'BOT_EXECUTION_INVALID_REQUEST', state: 'failed' }) : next());
  }, async (req, res) => {
    const operation = req.params.operation;
    const contract = Object.hasOwn(BOT_SERVICE_OPERATIONS, operation) ? BOT_SERVICE_OPERATIONS[operation] : null;
    const input = contract?.input.safeParse(req.body);
    if (!input?.success || new URL(req.originalUrl, 'http://agent').search
      || Buffer.byteLength(JSON.stringify(req.body)) > BOT_SERVICE_INPUT_BYTES) {
      return res.status(400).json({ code: 'BOT_EXECUTION_INVALID_REQUEST', state: 'failed' });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    const closed = () => { if (!res.writableEnded) abort(); };
    res.once('close', closed);
    try {
      const result = await services.execute(operation, input.data, { signal: controller.signal });
      const reply = botReplySchema(operation).safeParse({ association: botRequestAssociation(operation, input.data), result });
      if (!reply.success) throw botBoundaryError('BOT_EXECUTION_INVALID_RESPONSE');
      const body = JSON.stringify(reply.data);
      if (Buffer.byteLength(body) > BOT_SERVICE_BYTES) throw botBoundaryError('BOT_EXECUTION_RESPONSE_TOO_LARGE');
      return res.type('json').send(body);
    } catch (error) {
      const safeCode = /^(?:BOT_[A-Z0-9_]+|SOURCE_CONTROL_[A-Z0-9_]+|agent_(?:project_unregistered|directory_invalid)|enterprise_mode)$/.test(error?.code ?? '');
      const state = ['needs-you', 'outcome-unknown', 'failed', 'refused'].includes(error?.state) ? error.state : 'needs-you';
      const status = error?.status ?? error?.statusCode;
      return res.status(error?.code === 'agent_project_unregistered' ? 403
        : Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502)
        .json({ code: safeCode ? error.code : 'BOT_EXECUTION_FAILED', state });
    } finally {
      req.removeListener('aborted', abort); res.removeListener('close', closed);
    }
  });
}
