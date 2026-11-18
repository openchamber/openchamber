import type OpenAI from 'openai';

let pending: Promise<typeof OpenAI> | undefined;

export const loadOpenAI = () => {
  pending ??= import('openai').then((module) => module.default);
  return pending;
};
