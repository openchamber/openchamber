import type { OpenCodeClient, RequestOptions, SessionFormReplyInput } from '@opencode/client';
import type { FormValues } from './form-answer.js';

export interface ControlFormApi extends Omit<OpenCodeClient['session']['form'], 'reply'> {
  reply(input: Omit<SessionFormReplyInput, 'answer'> & { answer: FormValues }, options?: RequestOptions): Promise<void>;
}

export interface ControlSessionApi extends Omit<OpenCodeClient['session'], 'form'> {
  form: ControlFormApi;
}

export interface ControlClient extends Omit<OpenCodeClient, 'session'> {
  session: ControlSessionApi;
}
