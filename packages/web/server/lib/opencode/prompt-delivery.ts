import type { Socket } from 'node:net';
import type { Request, Response } from '../shared/http-contracts.js';

const UNDELIVERED_FAILURE_CLASSES = new Set(['connection_refused', 'dns_failed']);
const PROMPT_ROUTE = /^\/api\/session\/[^/?]+\/prompt(?:\?|$)/;

type PromptRequest = Pick<Request, 'method' | 'originalUrl'>;

const markPrompt = <Target extends Response | Socket>(req: PromptRequest, res: Target): Target => {
  if (req.method === 'POST' && PROMPT_ROUTE.test(req.originalUrl ?? '') && 'setHeader' in res && !res.headersSent) {
    res.setHeader('x-openchamber-error', 'opencode-unreachable');
  }
  return res;
};

export const markHeldPrompt = (req: PromptRequest, res: Response): Response => markPrompt(req, res);

export const markRefusedPrompt = (req: PromptRequest, res: Response | Socket, failureClass: string | undefined): Response | Socket => (
  failureClass !== undefined && UNDELIVERED_FAILURE_CLASSES.has(failureClass) ? markPrompt(req, res) : res
);
