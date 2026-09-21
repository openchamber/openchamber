/**
 * The OpenAI SDK is ~200 modules and only speech and transcription use it, so
 * it is loaded on the first call rather than with the server.
 */

let pending;

export const loadOpenAI = () => {
  pending ??= import('openai').then((module) => module.default);
  return pending;
};
